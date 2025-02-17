import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
    type Memory,
    stringToUuid
} from "@elizaos/core";
import { ClientBase } from "../base";
import { type IKeywordPlugin, type IKeywordAction } from "./KeywordActionPlugin";
import {
    Account,
    Aptos,
    AptosConfig,
    Ed25519PrivateKey,
    Network,
    PrivateKey,
    PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import { MOVEMENT_NETWORK_CONFIG, MOVEMENT_EXPLORER_URL, DEFAULT_NETWORK } from "../constants";
import { fallbackAction, type FallbackResult } from "./fallback";

export interface TokenTransferParams {
    token: string;
    amount: string;
    recipient: string;
    username: string;
    tweetId: string;
}

export class TokenTransferPlugin implements IKeywordPlugin {
    readonly name = "move-transfer";
    readonly description = "Plugin for handling MOVE transfer actions";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];

    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.registerActions();
        elizaLogger.info("TokenTransferPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("TokenTransferPlugin: Registered action:", {
            name: action.name,
            description: action.description
        });
    }

    private async createUserWallet(username: string, aptosClient: Aptos, movementAccount: Account, contractAddress: string): Promise<boolean> {
        try {
            const createUserTx = await aptosClient.transaction.build.simple({
                sender: movementAccount.accountAddress.toStringLong(),
                data: {
                    function: `${contractAddress}::user::create_user`,
                    typeArguments: [],
                    functionArguments: [username],
                },
            });

            const createUserCommitted = await aptosClient.signAndSubmitTransaction({
                signer: movementAccount,
                transaction: createUserTx,
            });

            const createUserResult = await aptosClient.waitForTransaction({
                transactionHash: createUserCommitted.hash,
                options: {
                    timeoutSecs: 30,
                    checkSuccess: true
                }
            });

            return createUserResult.success;
        } catch (error) {
            elizaLogger.error("Error creating user wallet:", error);
            throw error;
        }
    }

    private async getUserWalletAddress(username: string, aptosClient: Aptos, contractAddress: string): Promise<string | null> {
        try {
            const result = await aptosClient.view({
                payload: {
                    function: `${contractAddress}::user::get_user_address`,
                    typeArguments: [],
                    functionArguments: [username]
                }
            });
            return result[0] as string;
        } catch (error) {
            elizaLogger.info("User not found, creating user:", error instanceof Error ? error.message: String(error));
            const privateKey = this.runtime.getSetting("MOVEMENT_PRIVATE_KEY");
            if (!privateKey) {
                throw new Error("Missing MOVEMENT_PRIVATE_KEY configuration");
            }
            const movementAccount = Account.fromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(
                        privateKey,
                        PrivateKeyVariants.Ed25519
                    )
                ),
            });
            const success = await this.createUserWallet(username, aptosClient, movementAccount, contractAddress);
            if(success) {
                return await this.getUserWalletAddress(username, aptosClient, contractAddress);
            }
            return success[0] as string;
        }
    }

    public async stage_execute(params: TokenTransferParams): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
        action?: string;
        userWalletAddress?: string;
    }> {
        const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
        const aptosClient = new Aptos(new AptosConfig({
            network: Network.CUSTOM,
            fullnode: network.fullnode,
        }));

        let contractAddress: string;
        
        try {
            elizaLogger.info("TokenTransferPlugin: Executing transfer:", params);
            
            const privateKey = this.runtime.getSetting("MOVEMENT_PRIVATE_KEY");
            if (!privateKey) {
                throw new Error("Missing MOVEMENT_PRIVATE_KEY configuration");
            }

            const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
            if (!network) {
                throw new Error("Missing MOVEMENT_NETWORK configuration");
            }

            contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";

            const movementAccount = Account.fromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(
                        privateKey,
                        PrivateKeyVariants.Ed25519
                    )
                ),
            });

            const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                
            // First try to get user's wallet address
            try {
            
                // User exists, proceed with transfer
                // Convert amount to proper format (assuming MOVE_DECIMALS = 8)
                const amountInBaseUnits = BigInt(Number(params.amount) * Math.pow(10, 8));

                // Initial transfer attempt
                const tx = await aptosClient.transaction.build.simple({
                    sender: movementAccount.accountAddress.toStringLong(),
                    data: {
                        function: `${contractAddress}::transfer_move::execute`,
                        typeArguments: [],
                        functionArguments: [
                            params.username,
                            params.tweetId,
                            params.recipient,
                            amountInBaseUnits.toString()
                        ],
                    },
                });

                const committedTransaction = await aptosClient.signAndSubmitTransaction({
                    signer: movementAccount,
                    transaction: tx,
                });

                const result = await aptosClient.waitForTransaction({
                    transactionHash: committedTransaction.hash,
                    options: {
                        timeoutSecs: 30,
                        checkSuccess: true
                    }
                });

                // Check for specific error codes
                if (result.vm_status?.includes("0x13001")) {
                    return {
                        success: false,
                        error: `Insufficient balance. To complete this transfer:\n\n1. Top up your custodial wallet:\n${userWalletAddress}\n\n2. Try the transfer again after topping up.`,
                        action: "INSUFFICIENT_BALANCE",
                        userWalletAddress
                    };
                }

                // Check transaction success
                if (result.success) {
                    const networkSetting = this.runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                   
                    return {
                        success: true,
                        transactionId: result.hash,
                        action: "TRANSFER_SUCCESSFUL"
                    };
                } else {
                    return {
                        success: false,
                        error: result.vm_status || "Transaction failed",
                        action: "TRANSFER_FAILED"
                    };
                }
            } catch (error) {
                // Check if error is due to user not being registered (0x51001)
                if (error.message?.includes("0x51001") || error.message?.includes("331777")) {
                    elizaLogger.info("User not registered, attempting to create user:", params.username);
                    
                    try {
                        // Call create_user function
                        const createUserTx = await aptosClient.transaction.build.simple({
                            sender: movementAccount.accountAddress.toStringLong(),
                            data: {
                                function: `${contractAddress}::user::create_user`,
                                typeArguments: [],
                                functionArguments: [params.username],
                            },
                        });

                        const createUserCommitted = await aptosClient.signAndSubmitTransaction({
                            signer: movementAccount,
                            transaction: createUserTx,
                        });

                        const createUserResult = await aptosClient.waitForTransaction({
                            transactionHash: createUserCommitted.hash,
                            options: {
                                timeoutSecs: 30,
                                checkSuccess: true
                            }
                        });

                        if (createUserResult.success) {
                            elizaLogger.info("User created successfully, retrying transfer flow");
                            // User created successfully, retry the transfer
                            return await this.stage_execute(params);
                        } else {
                            elizaLogger.error("Failed to create user:", createUserResult);
                            return {
                                success: false,
                                error: "Failed to create user account: " + (createUserResult.vm_status || "Unknown error"),
                                action: "USER_CREATION_FAILED"
                            };
                        }
                    } catch (createError) {
                        elizaLogger.error("Error creating user:", createError);
                        return {
                            success: false,
                            error: "Failed to create user account: " + createError.message,
                            action: "USER_CREATION_FAILED"
                        };
                    }
                } else {
                    // If it's a different error, throw it to be caught by outer catch block
                    throw error;
                }
            }
        } catch (error) {
            elizaLogger.error("TokenTransferPlugin: Error executing transfer:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                params: {
                    ...params,
                    privateKey: undefined
                }
            });
            
            // Check if error message contains our specific error code
            if (error.message?.includes("0x13001")) {
                // Get user's wallet address for top-up
                const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                
                return {
                    success: false,
                    error: `Insufficient balance. To complete this transfer:\n\n1. Top up your custodial wallet:\n${userWalletAddress}\n\n2. Try the transfer again after topping up.`,
                    action: "INSUFFICIENT_BALANCE",
                    userWalletAddress: userWalletAddress || undefined
                };
            }
            
            return {
                success: false,
                error: error.message,
                action: "TRANSFER_FAILED"
            };
        }
    }

    private registerActions() {
        const transferAction: IKeywordAction = {
            name: "move_transfer",
            description: "Transfer MOVE tokens to another user",
            examples: [
                "@gmovebot transfer 100 MOVE to @user",
                "@gmovebot send 50 MOVE to @recipient",
                "@gmovebot transfer 200 MOVE tokens to @username",
                "@gmovebot send MOVE tokens to @user"
            ],
            requiredParameters: [
                {
                    name: "amount",
                    prompt: "How many MOVE tokens would you like to transfer?",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: amount
Parameter description: A positive number representing the amount of MOVE tokens to transfer. Can include decimals.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context
3. Return your response in this JSON format:
{
    "extracted": true/false,
    "value": "extracted_value or null if not found",
    "confidence": "HIGH/MEDIUM/LOW",
    "alternativeValues": ["other", "possible", "interpretations"],
    "clarificationNeeded": true/false,
    "suggestedPrompt": "A natural way to ask for clarification if needed",
    "reasoning": "Brief explanation of the extraction logic"
}

Only respond with the JSON, no other text.`,
                    validator: (value: string) => {
                        const num = Number(value);
                        return !isNaN(num) && num > 0;
                    }
                },
                {
                    name: "recipient",
                    prompt: "Who would you like to send the MOVE tokens to? (Please provide their Twitter username or wallet address)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: recipient
Parameter description: Twitter username (starting with @) of the recipient, make sure it is not @gmovebot or wallet address.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context
3. Return your response in this JSON format:
{
    "extracted": true/false,
    "value": "extracted_value or null if not found",
    "confidence": "HIGH/MEDIUM/LOW",
    "alternativeValues": ["other", "possible", "interpretations"],
    "clarificationNeeded": true/false,
    "suggestedPrompt": "A natural way to ask for clarification if needed",
    "reasoning": "Brief explanation of the extraction logic"
}

Only respond with the JSON, no other text.`,
                    validator: (value: string) => /^@?[A-Za-z0-9_]{1,15}$/.test(value)
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("TokenTransferPlugin: Processing transfer request for user:", tweet.username);

                // First, validate and collect all required parameters
                const amount = params.get("amount");
                if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
                    return {
                        response: "Please provide a valid positive number for the amount to transfer.",
                        action: "INVALID_AMOUNT"
                    };
                }

                let recipient = params.get("recipient");
                if (!recipient) {
                    return {
                        response: "Please provide the recipient's Twitter username.",
                        action: "NEED_RECIPIENT"
                    };
                }

                // Remove @ if present
                if (recipient.startsWith("@")) {
                    recipient = recipient.substring(1);
                }

                // Verify recipient exists and has a wallet
                try {
                    const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";
                    const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                    const aptosClient = new Aptos(
                        new AptosConfig({
                            network: Network.CUSTOM,
                            fullnode: network.fullnode,
                        })
                    );

                    const recipientAddress = await this.getUserWalletAddress(recipient, aptosClient, contractAddress);
                    if (!recipientAddress) {
                        return {
                            response: `@${recipient} doesn't have a wallet yet. They need to create one first by replying 'create wallet'.`,
                            action: "RECIPIENT_NO_WALLET"
                        };
                    }

                    // Now that we have all parameters and validations, prepare transfer params
                    const transferParams: TokenTransferParams = {
                        username: tweet.username,
                        token: "MOVE",
                        amount,
                        recipient: recipientAddress,
                        tweetId: tweet.id
                    };

                    // Execute the transfer
                    const result = await this.stage_execute(transferParams);

                    if (result.success) {
                        const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                        const network = MOVEMENT_NETWORK_CONFIG[networkSetting];
                        const explorerUrl = `${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`;

                        return {
                            response: `✅ Transfer successful!\n\nAmount: ${amount} MOVE\nTo: @${recipient}\n\nView transaction: ${explorerUrl}`,
                            data: { transactionId: result.transactionId },
                            action: "TRANSFER_SUCCESSFUL"
                        };
                    } else if (result.action === "WALLET_REQUIRED") {
                        return {
                            response: "You don't have a wallet yet. Reply 'create wallet' to create one.",
                            action: "PROMPT_REGISTRATION"
                        };
                    } else if (result.error?.includes("0x13001")) {
                        return {
                            response: `Insufficient balance. To complete this transfer:\n\n1. Top up your custodial wallet:\n${result.userWalletAddress}\n\n2. Try the transfer again after topping up.`,
                            action: "INSUFFICIENT_BALANCE"
                        };
                    } else {
                        return {
                            response: result.error || "Transfer failed. Please try again later.",
                            action: "TRANSFER_FAILED"
                        };
                    }
                } catch (error) {
                    elizaLogger.error("Error processing transfer:", error);
                    if (error.message?.includes("0x51001")) {
                        return {
                            response: "You don't have a wallet yet. Reply 'create wallet' to create one.",
                            action: "PROMPT_REGISTRATION"
                        };
                    }
                    return {
                        response: "An error occurred while processing your transfer. Please try again.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(transferAction);
    }
} 