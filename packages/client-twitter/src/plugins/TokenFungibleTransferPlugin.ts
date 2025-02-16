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

    private async transferByAddress(
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string,
        params: TokenFungibleTransferParams
    ): Promise<any> {
        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${contractAddress}::transfer_fa::transfer_token_by_token_address`,
                typeArguments: [],
                functionArguments: [
                    params.username,                                    // tuser_id
                    params.tokenAddress,                               // token_address
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

    private async checkVerifiedTokenBalance(
        aptosClient: Aptos, 
        contractAddress: string,
        tuser_id: string, 
        symbol: string
    ): Promise<{ isVerified: boolean; balance?: string }> {
        try {
            const result = await aptosClient.view({
                payload: {
                    function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_verified_token`,
                    typeArguments: [],
                    functionArguments: [tuser_id, symbol]
                }
            });
            return { isVerified: true, balance: result[0] as string };
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
                // First verify the user has a wallet
                const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                if (!userWalletAddress) {
                    return {
                        success: false,
                        error: "You don't have a wallet registered yet. Please create one first.",
                        action: "WALLET_REQUIRED"
                    };
                }

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
                } else if (params.symbol) {
                    result = await this.transferBySymbol(aptosClient, movementAccount, contractAddress, params);
                } else if (params.tokenAddress) {
                    result = await this.transferByAddress(aptosClient, movementAccount, contractAddress, params);
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
                throw error;
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
                "@radhemfeulb69 send 100 USDC to 0x53..."
            ],
            requiredParameters: [
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
                    validator: (value: string) => /^[A-Z0-9]{2,10}$/.test(value.toUpperCase())
                },
                {
                    name: "recipient",
                    prompt: "Please provide either the recipient's Twitter username (e.g., @user) or wallet address (starting with 0x)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: recipient
Parameter description: Either a Twitter username (starting with @) or a wallet address (starting with 0x).

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
                    validator: (value: string) => /^@?[A-Za-z0-9_]{1,15}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value)
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                const symbol = params.get("symbol").toUpperCase();
                const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";
                
                const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                const aptosClient = new Aptos(
                    new AptosConfig({
                        network: Network.CUSTOM,
                        fullnode: network.fullnode,
                    })
                );

                // First check if it's a verified token
                const verifiedCheck = await this.checkVerifiedTokenBalance(
                    aptosClient,
                    contractAddress,
                    tweet.username,
                    symbol
                );

                if (verifiedCheck.isVerified) {
                    // For verified token, ask for amount
                    return {
                        response: `How many ${symbol} tokens would you like to transfer? Your current balance is ${verifiedCheck.balance} ${symbol}`,
                        action: "COLLECT_AMOUNT"
                    };
                } else {
                    // For user-created token, ask for token owner
                    return {
                        response: `This appears to be a user-created token. Please provide the Twitter username of the token owner.`,
                        action: "COLLECT_TOKEN_OWNER"
                    };
                }
            }
        };

        const collectAmountAction: IKeywordAction = {
            name: "collect_amount",
            description: "Collect transfer amount",
            examples: ["100", "50.5"],
            requiredParameters: [
                {
                    name: "amount",
                    prompt: "How many tokens would you like to transfer?",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: amount
Parameter description: A positive number must be the amount of tokens to transfer. Can include decimals.

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
                    validator: (value: string) => !isNaN(Number(value)) && Number(value) > 0
                },
                {
                    name: "recipient",
                    prompt: "Who would you like to transfer to? (Twitter handle or wallet address)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: recipient
Parameter description: Either a Twitter username (starting with @) or a wallet address (starting with 0x).

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
                    validator: (value: string) => /^@?[A-Za-z0-9_]{1,15}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value)
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                const amount = params.get("amount");
                const recipient = params.get("recipient");
                const symbol = params.get("symbol");
                
                const transferParams: TokenFungibleTransferParams = {
                    username: tweet.username,
                    symbol: symbol,
                    recipient: recipient,
                    amount: amount,
                    tweetId: tweet.id
                };

                const result = await this.stage_execute(transferParams);

                if (result.success) {
                    const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting];
                    const explorerUrl = `${MOVEMENT_EXPLORER_URL}/${result.transactionId}?network=${network.explorerNetwork}`;
                    
                    const displayRecipient = recipient.startsWith("0x") ? recipient : `@${recipient}`;
                    return {
                        response: `✅ Transfer successful!\n\nAmount: ${amount} ${symbol}\nTo: ${displayRecipient}\n\nView transaction: ${explorerUrl}`,
                        data: { transactionId: result.transactionId },
                        action: "EXECUTE_ACTION"
                    };
                } else if (result.action === "WALLET_REQUIRED") {
                    return {
                        response: result.error + "\nUse '@radhemfeulb69 create wallet' to create one.",
                        action: "ERROR"
                    };
                } else {
                    return {
                        response: result.error || "Transfer failed. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        const collectTokenOwnerAction: IKeywordAction = {
            name: "collect_token_owner",
            description: "Collect token owner information",
            examples: ["@owner"],
            requiredParameters: [
                {
                    name: "token_owner",
                    prompt: "Please provide the Twitter username of the token owner",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: token_owner
Parameter description: A valid Twitter username (starting with @)

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
                    validator: (value: string) => /^@?\w{1,15}$/.test(value)
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                const tokenOwner = params.get("token_owner").replace('@', '');
                const symbol = params.get("symbol").toUpperCase();
                const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";

                const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                const aptosClient = new Aptos(
                    new AptosConfig({
                        network: Network.CUSTOM,
                        fullnode: network.fullnode,
                    })
                );

                try {
                    const balance = await this.checkUserCreatedTokenBalance(
                        aptosClient,
                        contractAddress,
                        tweet.username,
                        tokenOwner,
                        symbol
                    );

                    return {
                        response: `How many ${symbol} tokens would you like to transfer? Your current balance is ${balance} ${symbol}`,
                        action: "COLLECT_AMOUNT"
                    };
                } catch (error) {
                    if (error.message?.includes("0x51001")) {
                        return {
                            response: "Token owner not found. Please check the username and try again.",
                            action: "ERROR"
                        };
                    }
                    return {
                        response: "An error occurred while checking the token balance. Please try again.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(transferTokenAction);
        this.registerAction(collectAmountAction);
        this.registerAction(collectTokenOwnerAction);
    }
} 