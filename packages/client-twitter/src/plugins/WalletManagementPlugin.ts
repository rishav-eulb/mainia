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
import { ITextGenerationService } from "@elizaos/core";
import { ServiceType } from "@elizaos/core";

interface PendingWalletAction {
    username: string;
    action: 'GET_ADDRESS' | 'GET_BALANCE' | 'FINAL_CHECK';
    symbol?: string;
    tokenOwnerUsername?: string;
    lastPromptTime: number;
    attempts: number;
    state: 'NEED_TOKEN' | 'READY' | 'NEED_TOKEN_OWNER';
}

export interface WalletParams {
    username: string;
    action: 'GET_ADDRESS' | 'GET_BALANCE' | 'FINAL_CHECK';
    symbol?: string;
    tokenOwnerUsername?: string;
}

export class WalletManagementPlugin implements IKeywordPlugin {
    readonly name = "wallet-management";
    readonly description = "Plugin for handling wallet management actions";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];
    private pendingActions: Map<string, PendingWalletAction> = new Map();
    private readonly MAX_ATTEMPTS = 3;

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
                    } else if (['WBTC', 'WETH', 'USDC', 'USDT'].includes(params.symbol)) {
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
                } else if (params.action === 'FINAL_CHECK' && params.tokenOwnerUsername) {

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
        const tokenSymbolExtractionTemplate = `# Task: Extract token symbol from user's message in a conversational context

Parameter to extract: token symbol
Parameter requirements:
- Must be 2-10 characters long
- Should be treated as uppercase
- Allowed characters: letters (A-Z), digits (0-9), and optionally a leading '$'
- Must contain at least one letter (A-Z)
- Cannot be a common generic word like 'TOKEN' or 'COIN' by itself
- Should be unique and not overly generic

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Analyze the message for token symbol mentions
2. Consider both explicit (e.g., "$BTC") and implicit (e.g., "bitcoin", "btc") mentions
3. Return your response in this JSON format:
{
    "extracted": true/false,
    "symbol": "TOKEN_SYMBOL" or null if not found,
    "confidence": "HIGH/MEDIUM/LOW",
    "alternativeSymbols": ["other", "possible", "interpretations"],
    "clarificationNeeded": true/false,
    "suggestedPrompt": "A natural way to ask for clarification if needed",
    "reasoning": "Brief explanation of the extraction logic"
}

Only respond with the JSON, no other text.`;

        const walletAction: IKeywordAction = {
            name: "wallet_management",
            description: "Get user's wallet address or token balance",
            examples: [
                "@gmovebot what is my wallet address",
                "@gmovebot show my wallet address",
                "@gmovebot get my MOVE balance",
                "@gmovebot how much USDC do I have",
                "@gmovebot check my BTC balance",
                "@gmovebot show my TEST token balance from @owner"
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
                    validator: (value: string) => ['GET_ADDRESS', 'GET_BALANCE', 'FINAL_CHECK'].includes(value)
                }
            ],
            preprocessTweet: async (tweet: Tweet, runtime: IAgentRuntime) => {
                const text = tweet.text;
                const params = new Map<string, string>();

                // Extract action from text
                if (text.includes('address') || text.includes('wallet')) {
                    params.set('action', 'GET_ADDRESS');
                } else if (text.includes('balance') || text.includes('how much')) {
                    params.set('action', 'GET_BALANCE');

                    // Define verified tokens
                    const verifiedTokens = ['MOVE', 'WBTC', 'WETH', 'USDC', 'USDT', 'move', 'wbtc', 'weth', 'usdc', 'usdt'];
                    
                    // First check for verified tokens
                    const verifiedTokenMatch = text.match(new RegExp(`\\b(${verifiedTokens.join('|')})\\b`, 'i'));
                    if (verifiedTokenMatch) {
                        params.set('symbol', verifiedTokenMatch[0].toUpperCase());
                    } else {
                        // Use text generation service for token symbol extraction
                        const textGenerationService = runtime.getService<ITextGenerationService>(ServiceType.TEXT_GENERATION);
                        if (!textGenerationService) {
                            elizaLogger.warn("Text generation service not available, falling back to regex extraction");
                            // Fallback to regex extraction
                            const tokenPatterns = [
                                /\$([A-Za-z][A-Za-z0-9]{1,9})\b/i,  // Matches $TOKEN format
                                /\b([A-Za-z][A-Za-z0-9]{1,9}) (?:token|balance)\b/i,  // Matches "TOKEN balance" or "TOKEN token"
                                /(?:token|balance of) ([A-Za-z][A-Za-z0-9]{1,9})\b/i  // Matches "balance of TOKEN" or "token TOKEN"
                            ];

                            let tokenSymbol = null;
                            for (const pattern of tokenPatterns) {
                                const match = text.match(pattern);
                                if (match) {
                                    const candidate = match[1].toUpperCase();
                                    // Exclude common words that might be mistaken for tokens
                                    if (!['TOKEN', 'COIN', 'SEND', 'TRANSFER', 'TO', 'FROM', 'CHECK', 'GET', 'SHOW', 'MY'].includes(candidate)) {
                                        tokenSymbol = candidate;
                                        break;
                                    }
                                }
                            }

                            if (tokenSymbol) {
                                params.set('symbol', tokenSymbol);
                            }
                        } else {
                            try {
                                const result = await textGenerationService.queueTextCompletion(
                                    tokenSymbolExtractionTemplate.replace('{{userMessage}}', text)
                                        .replace('{{conversationContext}}', ''),
                                    0.0, // temperature
                                    [], // stop tokens
                                    0, // frequency penalty
                                    0, // presence penalty
                                    500 // max tokens
                                );

                                try {
                                    const parsed = JSON.parse(result);
                                    if (parsed.extracted && parsed.symbol) {
                                        params.set('symbol', parsed.symbol.toUpperCase());
                                    }
                                } catch (parseError) {
                                    elizaLogger.error("Error parsing LLM response:", parseError);
                                }
                            } catch (error) {
                                elizaLogger.error("Error using text generation service:", error);
                            }
                        }
                    }

                    // Check for token owner in case of user-created tokens
                    const ownerMatch = text.match(/from\s+@(\w+)/i);
                    if (ownerMatch) {
                        const potentialOwner = ownerMatch[0]
                        elizaLogger.info("potentialOwner", ownerMatch[0]);
                        // Don't set token owner if it matches the bot's username
                        
                            params.set('tokenOwnerUsername', potentialOwner.replace('@', ''));
                    
                    }
                }

                return params;
            },
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("WalletManagementPlugin: Processing request for user:", tweet.username);
                
                // Check for pending action
                const pendingAction = this.pendingActions.get(tweet.username);
                elizaLogger.info("pendingAction", pendingAction);
                if (pendingAction) {
                    // Update attempts
                    pendingAction.attempts++;
                    pendingAction.lastPromptTime = Date.now();

                    // Check max attempts
                    if (pendingAction.attempts > this.MAX_ATTEMPTS) {
                        this.pendingActions.delete(tweet.username);
                        return {
                            response: "I'm having trouble understanding. Let's start over - could you rephrase your request?",
                            action: "ERROR"
                        };
                    }

                    // Handle follow-up based on state
                    if (pendingAction.state === 'NEED_TOKEN') {
                        const symbol = params.get("symbol")?.toUpperCase();
                        if (symbol) {
                            pendingAction.symbol = symbol;
                            
                            // Check if we need token owner
                            if (!['MOVE', 'BTC', 'ETH', 'USDC', 'USDT', 'WETH'].includes(symbol)) {
                                pendingAction.state = 'NEED_TOKEN_OWNER';
                                return {
                                    response: `${symbol} appears to be a user-created token. Please provide the token owner's username (e.g., "from @owner")`,
                                    action: "FINAL_CHECK"
                                };
                            } else {
                                pendingAction.state = 'READY';
                            }
                        }
                    } else if (pendingAction.state === 'NEED_TOKEN_OWNER') {
                        const ownerMatch = tweet.text.match(/@[a-zA-Z0-9_]{1,15}/);
                        elizaLogger.info("ownerMatch", ownerMatch);
                        if (ownerMatch) {
                            const potentialOwner = ownerMatch[0];
                
                                pendingAction.tokenOwnerUsername = potentialOwner.replace('@', '');
                                pendingAction.state = 'READY';
                        
                        }
                    }

                    // If state is READY, execute the action
                    if (pendingAction.state === 'READY') {
                        const result = await this.stage_execute({
                            username: pendingAction.username,
                            action: pendingAction.action,
                            symbol: pendingAction.symbol,
                            tokenOwnerUsername: pendingAction.tokenOwnerUsername
                        });
                        
                        // Clean up pending action
                        this.pendingActions.delete(tweet.username);
                        
                        if (result.success) {
                            if (pendingAction.action === 'GET_ADDRESS') {
                                return {
                                    response: `Your custodial wallet address is:\n${result.address}`,
                                    action: "ADDRESS_RETRIEVED"
                                };
                            } else {
                                return {
                                    response: `Your ${pendingAction.symbol} balance is: ${result.balance} ${pendingAction.symbol}`,
                                    action: "BALANCE_RETRIEVED"
                                };
                            }
                        } else {
                            return {
                                response: result.error || "An error occurred while processing your request.",
                                action: "ERROR"
                            };
                        }
                    }

                    // // If we get here, we're still waiting for information
                    // return {
                    //     response: pendingAction.state === 'NEED_TOKEN' 
                    //         ? "Which token's balance would you like to check? (e.g., MOVE, BTC, ETH, USDC)"
                    //         : `Please provide the token owner's username (e.g., "from @owner")`,
                    //     action: pendingAction.state
                    // };
                }

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
                    action: action as 'GET_ADDRESS' | 'GET_BALANCE' | 'FINAL_CHECK'
                };

                // If it's a balance check, we need additional parameters
                if (action === 'GET_BALANCE') {
                    const symbol = params.get("symbol")?.toUpperCase();
                    if (!symbol) {
                        // Create pending action
                        this.pendingActions.set(tweet.username, {
                            username: tweet.username,
                            action: 'GET_BALANCE',
                            lastPromptTime: Date.now(),
                            attempts: 1,
                            state: 'NEED_TOKEN'
                        });
                        
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
                            // Create pending action
                            this.pendingActions.set(tweet.username, {
                                username: tweet.username,
                                action: 'FINAL_CHECK',
                                symbol,
                                lastPromptTime: Date.now(),
                                attempts: 1,
                                state: 'NEED_TOKEN_OWNER'
                            });
                            
                            return {
                                response: `${symbol} appears to be a user-created token. Please provide the token owner's username (e.g., "from @owner")`,
                                action: "FINAL_CHECK"
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
                } else if (result.action === "TOKEN_OWNER_VERIFIED") {
                    return {
                        response: "Token owner verified successfully.",
                        action: "TOKEN_OWNER_VERIFIED"
                    };
                } else if (result.needsRegistration) {
                    return {
                        response: "You don't have a wallet yet. Reply 'create wallet' to create one.",
                        action: "PROMPT_REGISTRATION"
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