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
} from "@aptos-labs/ts-sdk";
import { MOVEMENT_NETWORK_CONFIG, DEFAULT_NETWORK } from "../constants";

export interface WalletParams {
    username: string;
    action: 'GET_ADDRESS' | 'GET_BALANCE';
    symbol?: string;
    tokenOwnerUsername?: string;
}

export class WalletManagementPlugin implements IKeywordPlugin {
    readonly name = "wallet-management";
    readonly description = "Plugin for handling wallet management actions";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];

    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.registerActions();
        elizaLogger.info("WalletManagementPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("WalletManagementPlugin: Registered action:", {
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
            throw error;
        }
    }

    private async getWalletBalance(username: string, aptosClient: Aptos, contractAddress: string): Promise<string> {
        try {
            const result = await aptosClient.view({
                payload: {
                    function: `${contractAddress}::wallet::wallet_move_balance`,
                    typeArguments: [],
                    functionArguments: [username]
                }
            });
            const balanceInBaseUnits = BigInt(result[0] as string);
            const balanceInMove = Number(balanceInBaseUnits) / Math.pow(10, 8);
            return balanceInMove.toString();
        } catch (error) {
            elizaLogger.error("Error fetching wallet balance:", error);
            throw error;
        }
    }

    private async getVerifiedTokenBalance(username: string, aptosClient: Aptos, contractAddress: string, symbol: string): Promise<string> {
        const result = await aptosClient.view({
            payload: {
                function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_verified_token`,
                typeArguments: [],
                functionArguments: [username, symbol]
            }
        });
        const balanceInBaseUnits = BigInt(result[0] as string);
        const balanceInTokens = Number(balanceInBaseUnits) / Math.pow(10, 8);
        return balanceInTokens.toString();
    }

    private async getUnverifiedTokenBalance(username: string, aptosClient: Aptos, contractAddress: string, symbol: string, tokenOwnerUsername: string): Promise<string> {
        const result = await aptosClient.view({
            payload: {
                function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_user_created_token`,
                typeArguments: [],
                functionArguments: [username, tokenOwnerUsername, symbol]
            }
        });
        const balanceInBaseUnits = BigInt(result[0] as string);
        const balanceInTokens = Number(balanceInBaseUnits) / Math.pow(10, 8);
        return balanceInTokens.toString();
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

    private async stage_execute(params: WalletParams): Promise<{
        success: boolean;
        address?: string;
        balance?: string;
        error?: string;
        action?: string;
        needsRegistration?: boolean;
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

            let userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);

            if(!userWalletAddress) {
                const success = await this.createUserWallet(params.username, aptosClient, movementAccount, contractAddress);
                if(success) {
                    userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                }
            }

            try {
                
                if (params.action === 'GET_ADDRESS' ) {
                    return {
                        success: true,
                        address: userWalletAddress,
                        action: "ADDRESS_RETRIEVED"
                    };
                } else if (params.action === 'GET_BALANCE') {
                    if (params.symbol === 'MOVE') {
                        const balance = await this.getWalletBalance(params.username, aptosClient, contractAddress);
                        return {
                            success: true,
                            balance,
                            action: "BALANCE_RETRIEVED"
                        };
                    } else if (['BTC', 'ETH', 'USDC', 'USDT', 'WETH'].includes(params.symbol)) {
                        const balance = await this.getVerifiedTokenBalance(params.username, aptosClient, contractAddress, params.symbol);
                        return {
                            success: true,
                            balance,
                            action: "BALANCE_RETRIEVED"
                        };
                    } else if (params.tokenOwnerUsername) {
                        const balance = await this.getUnverifiedTokenBalance(
                            params.username,
                            aptosClient,
                            contractAddress,
                            params.symbol,
                            params.tokenOwnerUsername
                        );
                        return {
                            success: true,
                            balance,
                            action: "BALANCE_RETRIEVED"
                        };
                    } else {
                        return {
                            success: false,
                            error: "For user-created tokens, please provide the token owner's username",
                            action: "ERROR"
                        };
                    }
                }

            } catch (error) {
                // Check if error is due to user not being registered (0x51001)

                //TODO do we need this
                if (error.message?.includes("0x51001")) {
                    if (params.action === 'GET_ADDRESS') {
                        // Try to create wallet for address request
                        const success = await this.createUserWallet(
                            params.username,
                            aptosClient,
                            movementAccount,
                            contractAddress
                        );
                        
                        if (success) {
                            const address = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                            return {
                                success: true,
                                address,
                                action: "WALLET_CREATED"
                            };
                        }
                    }
                    
                    return {
                        success: false,
                        error: "No wallet registered. Would you like to create one?",
                        action: "WALLET_NOT_FOUND",
                        needsRegistration: true
                    };
                }
                throw error;
            }
        } catch (error) {
            elizaLogger.error("WalletManagementPlugin: Error executing action:", {
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
        const walletAction: IKeywordAction = {
            name: "wallet_management",
            description: "Get user's wallet address or token balance",
            examples: [
                "@radhemfeulb69 what is my wallet address",
                "@radhemfeulb69 show my wallet address",
                "@radhemfeulb69 get my MOVE balance",
                "@radhemfeulb69 how much USDC do I have",
                "@radhemfeulb69 check my BTC balance",
                "@radhemfeulb69 show my TEST token balance from @owner"
            ],
            requiredParameters: [
                {
                    name: "action",
                    prompt: "Would you like to check your wallet address or token balance?",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: action
Parameter description: Either 'GET_ADDRESS' for wallet address requests or 'GET_BALANCE' for balance checks.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider both explicit and implicit mentions in the context
3. Return your response in this JSON format:
{
    "extracted": true/false,
    "value": "GET_ADDRESS" or "GET_BALANCE" or null if not found,
    "confidence": "HIGH/MEDIUM/LOW",
    "alternativeValues": ["other", "possible", "interpretations"],
    "clarificationNeeded": true/false,
    "suggestedPrompt": "A natural way to ask for clarification if needed",
    "reasoning": "Brief explanation of the extraction logic"
}

Only respond with the JSON, no other text.`,
                    validator: (value: string) => ['GET_ADDRESS', 'GET_BALANCE'].includes(value)
                }
            ],
            preprocessTweet: async (tweet: Tweet, runtime: IAgentRuntime) => {
                const text = tweet.text.toLowerCase();
                const params = new Map<string, string>();

                // Extract action from text
                if (text.includes('address') || text.includes('wallet')) {
                    params.set('action', 'GET_ADDRESS');
                } else if (text.includes('balance') || text.includes('how much')) {
                    params.set('action', 'GET_BALANCE');

                    // If it's a balance check, try to extract the token symbol
                    const tokenMatch = text.match(/\b(move|btc|eth|usdc|usdt|weth|[a-z0-9]{2,10})\b/i);
                    if (tokenMatch) {
                        params.set('symbol', tokenMatch[1].toUpperCase());
                    }

                    // Check for token owner in case of user-created tokens
                    const ownerMatch = text.match(/from\s+@(\w+)/i);
                    if (ownerMatch) {
                        params.set('tokenOwnerUsername', ownerMatch[1]);
                    }
                }

                return params;
            },
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("WalletManagementPlugin: Processing request for user:", tweet.username);
                
                const action = params.get("action");
                if (!action) {
                    return {
                        response: "Would you like to check your wallet address or token balance?",
                        action: "NEED_ACTION"
                    };
                }

                // Prepare base parameters
                const walletParams: WalletParams = {
                    username: tweet.username,
                    action: action as 'GET_ADDRESS' | 'GET_BALANCE'
                };

                // If it's a balance check, we need additional parameters
                if (action === 'GET_BALANCE') {
                    const symbol = params.get("symbol")?.toUpperCase();
                    if (!symbol) {
                        return {
                            response: "Which token's balance would you like to check? (e.g., MOVE, BTC, ETH, USDC)",
                            action: "NEED_TOKEN"
                        };
                    }

                    walletParams.symbol = symbol;

                    // For non-verified tokens, we need the token owner
                    if (!['MOVE', 'BTC', 'ETH', 'USDC', 'USDT', 'WETH'].includes(symbol)) {
                        const tokenOwnerUsername = params.get("tokenOwnerUsername");
                        if (!tokenOwnerUsername) {
                            return {
                                response: `${symbol} appears to be a user-created token. Please provide the token owner's username (e.g., "check my ${symbol} balance from @owner")`,
                                action: "NEED_TOKEN_OWNER"
                            };
                        }
                        walletParams.tokenOwnerUsername = tokenOwnerUsername;
                    }
                }

                // Now that we have all required parameters, call stage_execute
                const result = await this.stage_execute(walletParams);

                if (result.success) {
                    if (action === 'GET_ADDRESS') {
                        if (result.action === "WALLET_CREATED") {
                            return {
                                response: `✅ Wallet created successfully!\n\nYour custodial wallet address is:\n${result.address}`,
                                action: "WALLET_CREATED"
                            };
                        } else {
                            return {
                                response: `Your custodial wallet address is:\n${result.address}`,
                                action: "ADDRESS_RETRIEVED"
                            };
                        }
                    } else { // GET_BALANCE
                        return {
                            response: `Your ${walletParams.symbol} balance is: ${result.balance} ${walletParams.symbol}`,
                            action: "BALANCE_RETRIEVED"
                        };
                    }
                } else if (result.needsRegistration) {
                    return {
                        response: "You don't have a wallet yet. Reply 'create wallet' to create one.",
                        action: "PROMPT_REGISTRATION"
                    };
                } else if (result.action === "NEED_TOKEN_OWNER") {
                    return {
                        response: `${walletParams.symbol} is a user-created token. Please provide the token owner's username (e.g., "check my ${walletParams.symbol} balance from @owner")`,
                        action: "NEED_TOKEN_OWNER"
                    };
                } else {
                    return {
                        response: result.error || "An error occurred while processing your request.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(walletAction);
    }
} 