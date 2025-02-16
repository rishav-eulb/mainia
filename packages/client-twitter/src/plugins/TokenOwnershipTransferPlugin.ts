import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
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
    AccountAddress
} from "@aptos-labs/ts-sdk";
import { MOVEMENT_NETWORK_CONFIG, DEFAULT_NETWORK, MOVEMENT_EXPLORER_URL } from "../constants";

export interface TokenOwnershipTransferParams {
    username: string;
    symbol?: string;        // Token symbol/ticker (required for symbol-based transfer)
    tokenAddress?: string;  // Token address (required for address-based transfer)
    recipient: string;      // New owner's address
    tweetId: string;       // Tweet ID for the transfer request
}

export class TokenOwnershipTransferPlugin implements IKeywordPlugin {
    readonly name = "token-ownership-transfer";
    readonly description = "Plugin for transferring token ownership";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];

    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.registerActions();
        elizaLogger.info("TokenOwnershipTransferPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("TokenOwnershipTransferPlugin: Registered action:", {
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

    private hexStringToUint8Array(hexString: string): Uint8Array {
        // Remove '0x' prefix if present
        const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
        const pairs = cleanHex.match(/[\dA-F]{2}/gi);
        if (!pairs) {
            throw new Error('Invalid hex string');
        }
        return new Uint8Array(pairs.map(s => parseInt(s, 16)));
    }

    private async transferOwnershipBySymbol(
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string,
        params: TokenOwnershipTransferParams
    ): Promise<any> {
        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${contractAddress}::manage_token::transfer_token_ownership_by_symbol`,
                typeArguments: [],
                functionArguments: [
                    params.username,    // tuser_id
                    params.symbol,      // symbol
                    new AccountAddress(this.hexStringToUint8Array(params.recipient)),  // to (as AccountAddress)
                ],
            },
        });

        const committedTx = await aptosClient.signAndSubmitTransaction({
            signer: movementAccount,
            transaction: tx,
        });

        return await aptosClient.waitForTransaction({
            transactionHash: committedTx.hash,
            options: { timeoutSecs: 30, checkSuccess: true }
        });
    }

    private async transferOwnershipByAddress(
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string,
        params: TokenOwnershipTransferParams
    ): Promise<any> {
        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${contractAddress}::manage_token::transfer_token_ownership_by_address`,
                typeArguments: [],
                functionArguments: [
                    params.username,     // tuser_id
                    params.tokenAddress, // token_metadata
                    new AccountAddress(this.hexStringToUint8Array(params.recipient)),  // to (as AccountAddress)
                ],
            },
        });

        const committedTx = await aptosClient.signAndSubmitTransaction({
            signer: movementAccount,
            transaction: tx,
        });

        return await aptosClient.waitForTransaction({
            transactionHash: committedTx.hash,
            options: { timeoutSecs: 30, checkSuccess: true }
        });
    }

    private async stage_execute(params: TokenOwnershipTransferParams): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
        action?: string;
        userWalletAddress?: string;
    }> {
        try {
            const privateKey = this.runtime.getSetting("MOVEMENT_PRIVATE_KEY");
            if (!privateKey) {
                throw new Error("Missing MOVEMENT_PRIVATE_KEY configuration");
            }

            const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
            if (!network) {
                throw new Error("Missing MOVEMENT_NETWORK configuration");
            }

            const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";

            const movementAccount = Account.fromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(
                        privateKey,
                        PrivateKeyVariants.Ed25519
                    )
                ),
            });

            const aptosClient = new Aptos(
                new AptosConfig({
                    network: Network.CUSTOM,
                    fullnode: network.fullnode,
                })
            );

            try {
                // First verify the user has a wallet
                const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                if (!userWalletAddress) {
                    return {
                        success: false,
                        error: "You don't have a wallet registered yet. Please create one first.",
                        action: "WALLET_REQUIRED"
                    };
                }

                // Execute transfer based on provided parameters
                let result;
                if (params.symbol) {
                    result = await this.transferOwnershipBySymbol(aptosClient, movementAccount, contractAddress, params);
                } else if (params.tokenAddress) {
                    result = await this.transferOwnershipByAddress(aptosClient, movementAccount, contractAddress, params);
                } else {
                    return {
                        success: false,
                        error: "Either token symbol or token address must be provided",
                        action: "INVALID_PARAMETERS"
                    };
                }

                if (result.success) {
                    return {
                        success: true,
                        transactionId: result.hash,
                        action: "OWNERSHIP_TRANSFERRED"
                    };
                } else {
                    return {
                        success: false,
                        error: result.vm_status || "Transaction failed",
                        action: "TRANSFER_FAILED"
                    };
                }

            } catch (error) {
                elizaLogger.error("TokenOwnershipTransferPlugin: Error executing transfer:", {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    params: {
                        ...params,
                        privateKey: undefined
                    }
                });

                // Check for specific error codes
                if (error.message?.includes("0x51001")) {
                    return {
                        success: false,
                        error: "You don't have a wallet registered yet. Please create one first.",
                        action: "WALLET_REQUIRED"
                    };
                }

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

                if (error.message?.includes("0x55004")) {
                    return {
                        success: false,
                        error: "You don't have ownership rights.",
                        action: "TOKEN_OWNERSHIP_NOT_FOUND"
                    };
                }

                if (error.message?.includes("0x65003")) {
                    return {
                        success: false,
                        error: "This token does not exist.",
                        action: "TOKEN_NOT_FOUND"
                    };
                }

                throw error;
            }
        } catch (error) {
            elizaLogger.error("TokenOwnershipTransferPlugin: Error executing transfer:", {
                error: error instanceof Error ? error.message : String(error),
                params
            });
            
            return {
                success: false,
                error: error.message,
                action: "EXECUTION_FAILED"
            };
        }
    }

    private registerActions() {
        const transferAction: IKeywordAction = {
            name: "transfer_token_ownership",
            description: "Transfer token ownership to another address",
            examples: [
                "@radhemfeulb69 transfer ownership of TEST to 0x123...",
                "@radhemfeulb69 transfer token ownership TEST to 0x456...",
                "@radhemfeulb69 transfer ownership of token 0x789... to 0x123...",
                "@radhemfeulb69 transfer token 0x789... ownership to 0x123...",
                "@radhemfeulb69 transfer ownership of token 0x789... to @user",
                "@radhemfeulb69 transfer ownership of token TEST to @user",
                "@radhemfeulb69 transfer token 0x789... ownership to @user",
                "@radhemfeulb69 transfer ownership to @user",
                 "@radhemfeulb69 transfer ownership to  0x125..."

            ],
            requiredParameters: [
                {
                    name: "tokenIdentifier",
                    prompt: "Please provide either the token symbol (e.g., TEST)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: tokenIdentifier
Parameter description: Either a token symbol (2-10 characters, uppercase).

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider both explicit and implicit mentions in the context
3. Consider common variations and synonyms
4. Return your response in this JSON format:
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
                        return /^[A-Z0-9]{2,10}$/.test(value);
                    }
                },
                {
                    name: "recipient",
                    prompt: "Please provide either the recipient's Twitter username (e.g., @user) or wallet address (starting with 0x)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: recipient
Parameter description: Either a Twitter username (starting with @) or a wallet address (starting with 0x) that will become the new owner.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider both explicit and implicit mentions in the context
3. Consider common variations and synonyms
4. Return your response in this JSON format:
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
                        return /^@?[A-Za-z0-9_]{1,15}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value);
                    }
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                try {
                    elizaLogger.info("TokenOwnershipTransferPlugin: Processing transfer with params:", Object.fromEntries(params));
                    
                    let recipient = params.get("recipient");
                    const tokenIdentifier = params.get("tokenIdentifier");
                    const tweetId = tweet.id;

                    // Handle recipient resolution
                    let recipientAddress: string;
                    if (recipient.startsWith("@")) {
                        recipient = recipient.substring(1); // Remove @ symbol
                    }
                    
                    if (!/^0x[0-9a-fA-F]{64}$/.test(recipient)) {
                        // If not a wallet address, treat as username and resolve address
                        const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";
                        const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                        const aptosClient = new Aptos(
                            new AptosConfig({
                                network: Network.CUSTOM,
                                fullnode: network.fullnode,
                            })
                        );
                        
                        const resolvedAddress = await this.getUserWalletAddress(recipient, aptosClient, contractAddress);
                        if (!resolvedAddress) {
                            return {
                                response: `Could not find a wallet address for user @${recipient}. Please provide a valid username or wallet address.`,
                                action: "ERROR"
                            };
                        }
                        recipientAddress = resolvedAddress;
                    } else {
                        recipientAddress = recipient;
                    }
                    
                    // Determine if tokenIdentifier is a symbol or address
                    const isAddress = tokenIdentifier.startsWith("0x");
                    
                    const transferParams: TokenOwnershipTransferParams = {
                        username: tweet.username,
                        tweetId: tweetId,
                        recipient: recipientAddress,
                        ...(isAddress ? { tokenAddress: tokenIdentifier } : { symbol: tokenIdentifier })
                    };

                    const result = await this.stage_execute(transferParams);

                    if (result.success) {
                        const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                        const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                        const explorerUrl = `${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`;
                        
                        const displayRecipient = recipient.startsWith("0x") ? recipient : `@${recipient}`;
                        return {
                            response: `✅ Token ownership transfer successful!\n\nToken: ${isAddress ? 'Token at ' + tokenIdentifier : tokenIdentifier}\nNew Owner: ${displayRecipient}\n\nView transaction: ${explorerUrl}`,
                            data: { transactionId: result.transactionId },
                            action: "EXECUTE_ACTION"
                        };
                    } else if (result.action === "WALLET_REQUIRED") {
                        return {
                            response: result.error + "\nUse '@movebot create wallet' to create one.",
                            action: "ERROR"
                        };
                    } else {
                        return {
                            response: result.error || "Ownership transfer failed. Please try again later.",
                            action: "ERROR"
                        };
                    }
                } catch (error) {
                    elizaLogger.error("Error in transfer action:", error);
                    return {
                        response: "An error occurred while processing the transfer. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(transferAction);
    }
} 