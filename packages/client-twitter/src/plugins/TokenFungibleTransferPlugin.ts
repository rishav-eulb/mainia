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
        username: string,
        symbol: string
    ): Promise<{ isVerified: boolean; balance?: string }> {
        try {
            const result = await aptosClient.view({
                payload: {
                    function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_verified_token`,
                    typeArguments: [],
                    functionArguments: [username, symbol]
                }
            });
            return { isVerified: true, balance: result[0] as string };
        } catch (error) {
            return { isVerified: false };
        }
    }

    private async checkUserCreatedTokenBalance(
        aptosClient: Aptos,
        contractAddress: string,
        username: string,
        tokenOwnerUsername: string,
        symbol: string
    ): Promise<{ balance?: string; error?: string }> {
        try {
            const result = await aptosClient.view({
                payload: {
                    function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_user_created_token`,
                    typeArguments: [],
                    functionArguments: [username, tokenOwnerUsername, symbol]
                }
            });
            return { balance: result[0] as string };
        } catch (error) {
            return { error: error.message };
        }
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
        const transferAction: IKeywordAction = {
            name: "transfer_fungible_token",
            description: "Transfer fungible tokens to an address",
            examples: [
                "@radhemfeulb69 I want to transfer some tokens",
                "I want to send some tokens",
                "How do I send tokens?",
                "Can you help me send tokens ?",
                "I need help transferring tokens",
                "@radhemfeulb69 transfer 100 TEST to @user",
                "@radhemfeulb69 send 50 TEST from @creator to 0x456...",
                "@radhemfeulb69 transfer token 0x789... 75 to 0x123...",
                "@radhemfeulb69 send 200 tokens at 0x789... to 0x123..."
            ],
            requiredParameters: [
                {
                    name: "tokenIdentifier",
                    prompt: "Please provide either the token symbol (e.g., TEST) or the token address (starting with 0x)",
                    validator: (value: string) => {
                        // Accept either a symbol (2-10 chars) or an address (0x...)
                        return /^[A-Z0-9]{2,10}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value);
                    }
                },
                {
                    name: "tokenOwner",
                    prompt: "Please provide the token creator's username (e.g., @creator)",
                    validator: (value: string) => {
                        return /^@?[A-Za-z0-9_]{1,15}$/.test(value);
                    },
                    optional: true
                },
                {
                    name: "amount",
                    prompt: "How many tokens would you like to transfer?",
                    validator: (value: string) => {
                        const num = Number(value);
                        return !isNaN(num) && num > 0;
                    }
                },
                {
                    name: "recipient",
                    prompt: "Please provide either the recipient's Twitter username (e.g., @user) or wallet address (starting with 0x)",
                    validator: (value: string) => {
                        // Accept either a Twitter handle or a wallet address
                        return /^@?[A-Za-z0-9_]{1,15}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value);
                    }
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("TokenFungibleTransferPlugin: Processing transfer with params:", Object.fromEntries(params));
                
                let recipient = params.get("recipient");
                const tokenIdentifier = params.get("tokenIdentifier");
                const amount = params.get("amount");
                const tweetId = tweet.id;
                let tokenOwner = params.get("tokenOwner");

                // Handle recipient resolution
                let recipientAddress: string;
                if (recipient.startsWith("@")) {
                    recipient = recipient.substring(1); // Remove @ symbol
                }
                
                try {
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
                    
                    if (!isAddress) {
                        // Check if it's a verified token
                        const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";
                        const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                        const aptosClient = new Aptos(
                            new AptosConfig({
                                network: Network.CUSTOM,
                                fullnode: network.fullnode,
                            })
                        );

                        const verifiedCheck = await this.checkVerifiedTokenBalance(
                            aptosClient,
                            contractAddress,
                            tweet.username,
                            tokenIdentifier
                        );

                        if (verifiedCheck.isVerified) {
                            // It's a verified token, check balance
                            const balance = BigInt(verifiedCheck.balance);
                            const requestedAmount = BigInt(Math.floor(Number(amount) * Math.pow(10, 8)));
                            
                            if (balance < requestedAmount) {
                                return {
                                    response: `Insufficient balance. You have ${Number(balance) / Math.pow(10, 8)} ${tokenIdentifier} but tried to send ${amount} ${tokenIdentifier}. Please top up your wallet and try again.`,
                                    action: "INSUFFICIENT_BALANCE"
                                };
                            }
                        } else {
                            // Not a verified token, need token owner
                            if (!tokenOwner) {
                                return {
                                    response: "This appears to be a user-created token. Please provide the token creator's username.",
                                    action: "NEED_TOKEN_OWNER"
                                };
                            }

                            // Remove @ if present
                            if (tokenOwner.startsWith("@")) {
                                tokenOwner = tokenOwner.substring(1);
                            }

                            // Check balance for user-created token
                            const userTokenCheck = await this.checkUserCreatedTokenBalance(
                                aptosClient,
                                contractAddress,
                                tweet.username,
                                tokenOwner,
                                tokenIdentifier
                            );

                            if (userTokenCheck.error) {
                                return {
                                    response: `Error checking token balance: ${userTokenCheck.error}`,
                                    action: "ERROR"
                                };
                            }

                            const balance = BigInt(userTokenCheck.balance);
                            const requestedAmount = BigInt(Math.floor(Number(amount) * Math.pow(10, 8)));
                            
                            if (balance < requestedAmount) {
                                return {
                                    response: `Insufficient balance. You have ${Number(balance) / Math.pow(10, 8)} ${tokenIdentifier} but tried to send ${amount} ${tokenIdentifier}. Please top up your wallet and try again.`,
                                    action: "INSUFFICIENT_BALANCE"
                                };
                            }
                        }
                    }

                    const transferParams: TokenFungibleTransferParams = {
                        username: tweet.username,
                        tweetId,
                        amount,
                        recipient: recipientAddress,
                        ...(isAddress ? { tokenAddress: tokenIdentifier } : { 
                            symbol: tokenIdentifier,
                            tokenCreator: tokenOwner
                        })
                    };

                    const result = await this.stage_execute(transferParams);

                    if (result.success) {
                        const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                        const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                        const explorerUrl = `${MOVEMENT_EXPLORER_URL}/${result.transactionId}?network=${network.explorerNetwork}`;
                        
                        const displayRecipient = recipient.startsWith("0x") ? recipient : `@${recipient}`;
                        return {
                            response: `✅ Transfer successful!\n\nAmount: ${amount} ${isAddress ? 'tokens' : tokenIdentifier}\nTo: ${displayRecipient}\n\nView transaction: ${explorerUrl}`,
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
                            response: result.error || "Transfer failed. Please try again later.",
                            action: "ERROR"
                        };
                    }
                } catch (error) {
                    return {
                        response: `Error processing transfer: ${error.message}`,
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(transferAction);
    }
} 