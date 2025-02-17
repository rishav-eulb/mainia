import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
} from "@elizaos/core";
import { ClientBase } from "../base";
import { type IKeywordPlugin, type IKeywordAction, ValidationPromptRequest } from "./KeywordActionPlugin";
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
import { TokenTransferPlugin } from "./TokenTransferPlugin";
import { sendTweet } from "../utils";
import { Address } from "@coinbase/coinbase-sdk";
export interface TokenFungibleTransferParams {
    username: string;
    tokenCreator?: string;  // Optional token creator's twitter handle
    symbol?: string;        // Token symbol/ticker (required for symbol-based transfer)
    tokenAddress?: string;  // Token address (required for address-based transfer)
    recipient: string;      // Recipient address
    amount: string;
    tweetId: string;
    isVerified: boolean;
}


export class TokenFungibleTransferPlugin implements IKeywordPlugin {
    readonly name = "token-fungible-transfer";
    readonly description = "Plugin for handling fungible token transfers";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];
    private tokenTransferPlugin: TokenTransferPlugin;
    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.tokenTransferPlugin = new TokenTransferPlugin();
        await this.tokenTransferPlugin.initialize(client, runtime);
        this.registerActions();
        elizaLogger.info("TokenFungibleTransferPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("TokenFungibleTransferPlugin: Registered action:", {
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

    private async transferBySymbol(
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string,
        params: TokenFungibleTransferParams
    ): Promise<any> {
        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${contractAddress}::transfer_fa::transfer_token_by_tuser_id_and_symbol`,
                typeArguments: [],
                functionArguments: [
                    params.username,                                    // tuser_id
                    params.tokenCreator || params.username,            // token_tuser_id (defaults to sender if not specified)
                    params.symbol || "",                               // symbol
                    new AccountAddress(this.hexStringToUint8Array(params.recipient)),  // to (as AccountAddress)
                    BigInt(Math.floor(Number(params.amount) * Math.pow(10, 8)))   // amount (converted to base units)
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

    private async transferBySymbolAndTokenOwner(
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string,
        params: TokenFungibleTransferParams
    ): Promise<any> {
        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${contractAddress}::transfer_fa::transfer_token_by_tuser_id_and_symbol`,
                typeArguments: [],
                functionArguments: [
                    params.username,                                   // tuser_id
                    params.tokenCreator, // token creator twitter handle
                    params.symbol, // token symbol
                    new AccountAddress(this.hexStringToUint8Array(params.recipient)),  // to (as AccountAddress)
                    BigInt(Math.floor(Number(params.amount) * Math.pow(10, 8)))   // amount (converted to base units)
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

    private async checkTokenVerified(
        aptosClient: Aptos, 
        contractAddress: string,
        symbol: string
    ): Promise<{ isVerified: boolean; metadata?: string }> {
        try {
            const result = await aptosClient.view<[{ inner: string }]>({
                payload: {
                    function: `${contractAddress}::fa_wallet::get_metadata_for_verified_fa`,
                    typeArguments: [],
                    functionArguments: [symbol]
                }
            });
            return { isVerified: true, metadata: result[0].inner as string };
        } catch (error) {
            // If error occurs, token is not verified
            return { isVerified: false };
        }
    }

    private async checkUserCreatedTokenBalance(
        aptosClient: Aptos,
        contractAddress: string,
        tuser_id: string,
        token_owner_tuser_id: string,
        symbol: string
    ): Promise<string> {
        const result = await aptosClient.view({
            payload: {
                function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_user_created_token`,
                typeArguments: [],
                functionArguments: [tuser_id, token_owner_tuser_id, symbol]
            }
        });
        return result[0] as string;
    }

    private async stage_execute(params: TokenFungibleTransferParams): Promise<{
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

                let movementTokenparam = {
                    token: "MOVE",
                    amount: params.amount,
                    recipient: params.recipient,
                    username: params.username,
                    tweetId: params.tweetId
                }

                // Execute transfer based on provided parameters
                let result;
                if (params.symbol && (params.symbol == "MOVE" || params.symbol == "move")) {
                    result = await this.tokenTransferPlugin.stage_execute(movementTokenparam);
                } else if (params.symbol && params.isVerified) {
                    result = await this.transferBySymbol(aptosClient, movementAccount, contractAddress, params);
                } else if (params.tokenCreator && params.symbol && !params.isVerified) {
                    result = await this.transferBySymbolAndTokenOwner(aptosClient, movementAccount, contractAddress, params);
                }
                 else {
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
                if (error.message?.includes("0x51001")) {
                    return {
                        success: false,
                        error: "You don't have a wallet registered yet. Please create one first.",
                        action: "WALLET_REQUIRED"
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
                //TODO: Handle the error, error can be insufficient balance (if this is the case, ask user to top up their wallet), or wallet not created (if this is the case, ask user to create a wallet by prompting create a wallet) 
            }
            
        } catch (error) {
            elizaLogger.error("TokenFungibleTransferPlugin: Error executing transfer:", {
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
        const transferTokenAction: IKeywordAction = {
            name: "transfer_token",
            description: "Transfer tokens to another user or address",
            examples: [
                "@radhemfeulb69 transfer 100 tokens to @user",
                "@radhemfeulb69 send 50 TEST to 0x123...",
                "@radhemfeulb69 can you some USDC to @user",
                "@radhemfeulb69 send 100 USDC to 0x53...",
                "@radhemfeulb69 send some tokens to 0x53...",
                "@radhemfeulb69 can you please send some tokens to @user",
            ],
            requiredParameters: [
                {
                    name: "amount",
                    prompt: "How many tokens would you like to transfer?",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: amount
Parameter description: A positive number representing the amount of tokens to transfer. Can include decimals.

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
                    name: "symbol",
                    prompt: "What token would you like to transfer?",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: symbol
Parameter description: Token symbol must be 2-10 characters long, uppercase letters and numbers only.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
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
                    validatorWithPromptRequest: async (value, runtime): Promise<ValidationPromptRequest> => {
                        const validationResult = /^[A-Z0-9]{2,10}$/.test(value.toUpperCase());
                        if(!validationResult) {
                            return {
                                isValidated: false
                            }
                        }

                        const symbol = value.toUpperCase();
                        const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";
                        const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];

                        const aptosClient = new Aptos(
                            new AptosConfig({
                                network: Network.CUSTOM,
                                fullnode: network.fullnode,
                            })
                        );

                        // For other tokens, check if verified
                        const verifiedCheck = await this.checkTokenVerified(
                            aptosClient,
                            contractAddress,
                            symbol
                        );
                        
                        elizaLogger.info("TokenFungibleTransferPlugin: Verified check:", verifiedCheck);
                        if(verifiedCheck.isVerified) {
                            return {
                                isValidated: true
                            }
                        }
                        
                        elizaLogger.info("TokenFungibleTransferPlugin: Optional Check:", verifiedCheck);
                        return {
                            isValidated: true,
                            optionalParameterName: "tokenOwner",
                            optionalParameterPrompt: "This token is not verified. Please provide either the token owner's Twitter username (e.g., @user)"
                        }
                    },
                },
                {
                    name: "recipient",
                    prompt: "Please provide either the recipient's Twitter username (e.g., @user) or wallet address (starting with 0x)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: recipient
Parameter description: Either a Twitter username (starting with @, don't confuse it with @radhemfeulb69) or a wallet address (starting with 0x, please don't confuse it with token owner address).

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context
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
                    validator: (value: string) => /^@?[A-Za-z0-9_]{1,15}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value)
                },
            ],
            optionalParameters: [
                {
                    name: "tokenOwner",
                    prompt: "Please provide either the token owner's Twitter username (e.g., @user)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: tokenOwner
Parameter description: Either a Twitter username (starting with @, don't confuse it with @radhemfeulb69 or recipient name ) or a wallet address (starting with 0x, please don't confuse it with recipient address).

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}


# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context
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
                    validator: (value: string) => /^@?[A-Za-z0-9_]{1,15}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value)
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                const symbol = params.get("symbol").toUpperCase().replace("$", "");
                const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";
                
                const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];

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

                const aptosClient = new Aptos(
                    new AptosConfig({
                        network: Network.CUSTOM,
                        fullnode: network.fullnode,
                    })
                );

                // Check if user has a wallet
                let userWalletAddress = await this.getUserWalletAddress(tweet.username, aptosClient, contractAddress);

                let recipient = params.get('recipient');
                // If not self soul-bound, resolve recipient address
                if (recipient.startsWith("@")) {
                    const username = recipient.substring(1);
                    const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                    const aptosClient = new Aptos(new AptosConfig({
                        network: Network.CUSTOM,
                        fullnode: network.fullnode,
                    }));
                    
                    const resolvedAddress = await this.getUserWalletAddress(
                        username,
                        aptosClient,
                        "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d"
                    );
                    
                    if (!resolvedAddress) {
                        return {
                            response: "Cannot find any wallet linked to the twitter handle provided.",
                            action: "ERROR"
                        };
                    }
                    recipient = resolvedAddress;
                }

                try {
                    // Handle MOVE token separately
                    if (symbol === 'MOVE') {
                        const transferParams: TokenFungibleTransferParams = {
                            username: tweet.username,
                            symbol: symbol,
                            recipient,
                            amount: params.get("amount"),
                            tweetId: tweet.id,
                            isVerified: true
                        };
                        
                        const result = await this.stage_execute(transferParams);
                        
                        if (result.success) {
                            const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                            const network = MOVEMENT_NETWORK_CONFIG[networkSetting];
                            const explorerUrl = `${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`;
                            
                            return {
                                response: `✅ Transfer successful!\n\nAmount: ${params.get("amount")} ${symbol}\nTo: ${params.get("recipient")}\n\nView transaction: ${explorerUrl}`,
                                action: "TRANSFER_SUCCESSFUL"
                            };
                        } else if (result.error?.includes("0x13001")) {
                            return {
                                response: `Your MOVE balance is insufficient. Please top up your wallet first.`,
                                action: "INSUFFICIENT_BALANCE"
                            };
                        } else {
                            return {
                                response: result.error || "Transfer failed. Please try again later.",
                                action: "TRANSFER_FAILED"
                            };
                        }
                    }

                    // For other tokens, check if verified
                    const verifiedCheck = await this.checkTokenVerified(
                        aptosClient,
                        contractAddress,
                        symbol
                    );

                    if (verifiedCheck.isVerified) {
                        // For verified token, proceed with transfer
                        const transferParams: TokenFungibleTransferParams = {
                            username: tweet.username,
                            symbol: symbol,
                            recipient,
                            amount: params.get("amount"),
                            tweetId: tweet.id,
                            isVerified: true
                        };
                
                        const result = await this.stage_execute(transferParams);

                        if (result.success) {
                            const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                            const network = MOVEMENT_NETWORK_CONFIG[networkSetting];
                            const explorerUrl = `${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`;
                            
                            return {
                                response: `✅ Transfer successful!\n\nAmount: ${params.get("amount")} ${symbol}\nTo: ${params.get("recipient")}\n\nView transaction: ${explorerUrl}`,
                                action: "TRANSFER_SUCCESSFUL"
                            };
                        } else if (result.error?.includes("0x13001")) {
                            return {
                                response: `Your ${symbol} balance is insufficient. Please top up your wallet first.`,
                                action: "INSUFFICIENT_BALANCE"
                            };
                        } else {
                            return {
                                response: result.error || "Transfer failed. Please try again later.",
                                action: "TRANSFER_FAILED"
                            };
                        }
                    } else if (params.has("tokenOwner") && params.has("symbol") && !verifiedCheck.isVerified) {
                        // Handle transfer by token address
                        const transferParams: TokenFungibleTransferParams = {
                            username: tweet.username,
                            tokenCreator: params.get("tokenOwner").replace("@", ""),
                            symbol: symbol,
                            recipient,
                            amount: params.get("amount"),
                            tweetId: tweet.id,
                            isVerified: false
                        };

                        const result = await this.stage_execute(transferParams);

                        if (result.success) {
                            const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                            const network = MOVEMENT_NETWORK_CONFIG[networkSetting];
                            const explorerUrl = `${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`;
                            
                            return {
                                response: `✅ Transfer successful!\n\nAmount: ${params.get("amount")} ${symbol}\nTo: ${params.get("recipient")}\n\nView transaction: ${explorerUrl}`,
                                action: "TRANSFER_SUCCESSFUL"
                            };
                        } else if (result.error?.includes("0x13001")) {
                            return {
                                response: `Your ${symbol} balance is insufficient. Please top up your wallet first.`,
                                action: "INSUFFICIENT_BALANCE"
                            };
                        } else {
                            return {
                                response: result.error || "Transfer failed. Please try again later.",
                                action: "TRANSFER_FAILED"
                            };
                        }
                    } else {
                        return {
                            response: "Cannot determine the token details based on the details provided.",
                            action: "INVALID_TOKEN_PARAMS"
                        };
                    }
                } catch (error) {
                    if (error.message?.includes("0x51001")) {
                        return {
                            response: "You don't have a wallet yet. Reply 'create wallet' to create one.",
                            action: "ERROR"
                        };
                    }
                    return {
                        response: "An error occurred while processing your request. Please try again.",
                        action: "ERROR"
                    };
                }

                return {
                    response: "Invalid transfer request. Please try again with correct parameters.",
                    action: "ERROR"
                };
            }
        };

        this.registerAction(transferTokenAction);
    }
} 