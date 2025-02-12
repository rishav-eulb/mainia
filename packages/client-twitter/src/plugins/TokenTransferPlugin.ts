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
    readonly name = "token-transfer";
    readonly description = "Plugin for handling token transfer actions";
    
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
            elizaLogger.error("Error fetching user wallet address:", {
                error: error instanceof Error ? error.message : String(error),
                username
            });
            // Rethrow the error so it can be caught and handled by stage_execute
            throw error;
        }
    }

    private async stage_execute(params: TokenTransferParams): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
        action?: string;
        userWalletAddress?: string;
    }> {
        let aptosClient: Aptos;
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

            aptosClient = new Aptos(
                new AptosConfig({
                    network: Network.CUSTOM,
                    fullnode: network.fullnode,
                })
            );

            // First try to get user's wallet address
            try {
                const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                if (!userWalletAddress) {
                    return {
                        success: false,
                        error: "Failed to get user wallet address",
                        action: "USER_NOT_FOUND"
                    };
                }

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
            name: "transfer_tokens",
            description: "Transfer tokens to another user",
            examples: [
                "@radhemfeulb69 send 100 USDC to @user",
                "@radhemfeulb69 transfer 50 ETH to @recipient",
                "@radhemfeulb69 send 25 USDC to @alice",
                "@radhemfeulb69 send 48 USDC to @user",
                "@radhemfeulb69 transfer 50 ETH to @user",
                "@radhemfeulb69 send 79 USDC to\n@user",  // Handle newline cases
                "@radhemfeulb69 transfer 100 to @user",
                "@radhemfeulb69 send 50 to @user",
                "@radhemfeulb69 send 30 Move to @user",
                "@radhemfeulb69 transfer 69 MOVE to @user",
                "I want to send some tokens",
                "How do I send tokens?",
                "Can you help me send tokens?",
                "I need help transferring tokens",
                "Show me how to transfer tokens"
            ],
            requiredParameters: [
                {
                    name: "amount",
                    prompt: "How many MOVE tokens would you like to transfer?",
                    validator: (value: string) => {
                        const num = Number(value);
                        return !isNaN(num) && num > 0 && !value.startsWith('0x');
                    },
                    extractorTemplate: `# Task: Extract the numeric amount from this transfer request
Message: {{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Look for an explicit number followed by MOVE/Move/move or just a number
2. Do not infer or assume amounts - only extract explicitly stated numbers
3. If multiple numbers exist, take the one that appears to be the transfer amount
4. Handle decimal numbers if present
5. Ignore any wallet addresses (starting with 0x) - these are not amounts
6. Return EXACTLY this JSON format:
{
    "extracted": true,
    "value": "50",
    "confidence": "HIGH",
    "alternativeValues": [],
    "clarificationNeeded": false,
    "reasoning": "Found explicit amount 50 in the message"
}

OR if no explicit amount found:
{
    "extracted": false,
    "value": null,
    "confidence": "LOW",
    "alternativeValues": [],
    "clarificationNeeded": true,
    "suggestedPrompt": "How many MOVE tokens would you like to transfer?",
    "reasoning": "No explicit amount found in message"
}`
                },
                {
                    name: "recipient",
                    prompt: "Please provide the recipient's wallet address (must be a valid 66-character address starting with 0x)",
                    validator: (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value),
                    extractorTemplate: `# Task: Extract the wallet address from this transfer request
Message: {{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Look for a valid Aptos wallet address that:
   - Starts with 0x
   - Is followed by exactly 64 hexadecimal characters (0-9, a-f, A-F)
   - Total length should be 66 characters
2. Handle cases where the address might be on a new line
3. Do not confuse numeric amounts with wallet addresses
4. Return EXACTLY this JSON format:
{
    "extracted": true,
    "value": "0x1234...5678",
    "confidence": "HIGH",
    "alternativeValues": [],
    "clarificationNeeded": false,
    "reasoning": "Found valid wallet address in the message"
}

OR if no valid wallet address found:
{
    "extracted": false,
    "value": null,
    "confidence": "LOW",
    "alternativeValues": [],
    "clarificationNeeded": true,
    "suggestedPrompt": "Please provide a valid wallet address (must start with 0x followed by 64 characters)",
    "reasoning": "No valid wallet address found in message"
}`
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("TokenTransferPlugin: Processing transfer action with params:", Object.fromEntries(params));
                
                // Validate all required parameters are present and in correct format
                const amount = params.get("amount");
                const recipient = params.get("recipient");
                const token = params.get("tokenType") || "MOVE";

                // Additional validation to ensure amount is not a wallet address
                if (!amount || amount.startsWith('0x')) {
                    return {
                        response: "Invalid amount specified. Please provide a numeric amount of MOVE tokens to transfer.",
                        action: "ERROR"
                    };
                }

                // Additional validation for recipient wallet address
                if (!recipient || !recipient.startsWith('0x') || recipient.length !== 66) {
                    return {
                        response: "Invalid recipient address. Please provide a valid wallet address (must start with 0x followed by 64 characters).",
                        action: "ERROR"
                    };
                }

                const transferParams: TokenTransferParams = {
                    token,
                    amount,
                    recipient,
                    username: tweet.username,
                    tweetId: tweet.id
                };

                const result = await this.stage_execute(transferParams);

                if (result.success) {
                    const networkSetting = this.runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                   
                    return {
                        response: `✅ Transfer successful!\n\nAmount: ${transferParams.amount} ${transferParams.token}\nTo: ${transferParams.recipient}\n`,
                        data: { transactionId: result.transactionId },
                        action: "EXECUTE_ACTION"
                    };
                } else if (result.action === "INSUFFICIENT_BALANCE") {
                    return {
                        response: result.error,  // Use the detailed error message with wallet address
                        action: "ERROR"
                    };
                } else {
                    return {
                        response: "❌ Transfer failed. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(transferAction);
    }
} 