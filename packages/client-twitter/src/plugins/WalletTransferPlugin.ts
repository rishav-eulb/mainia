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

export interface WalletTransferParams {
    username: string;
    tokenSymbol: string;
    tokenOwnerUsername?: string;
    recipient?: string;
    amount?: string;
    tweetId: string;
}

export class WalletTransferPlugin implements IKeywordPlugin {
    readonly name = "wallet-transfer";
    readonly description = "Plugin for handling all token transfers (MOVE and FA tokens)";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];

    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.registerActions();
        elizaLogger.info("WalletTransferPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("WalletTransferPlugin: Registered action:", {
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

    private async checkTokenVerification(
        tokenSymbol: string,
        aptosClient: Aptos,
        contractAddress: string
    ): Promise<boolean> {
        try {
            await aptosClient.view({
                payload: {
                    function: `${contractAddress}::repository::get_metadata_for_verified_fa`,
                    typeArguments: [],
                    functionArguments: [tokenSymbol]
                }
            });
            return true;
        } catch (error) {
            if (error.message?.includes("0x51002")) {
                return false;
            }
            throw error;
        }
    }

    private async getVerifiedTokenBalance(
        username: string,
        tokenSymbol: string,
        aptosClient: Aptos,
        contractAddress: string
    ): Promise<string> {
        const result = await aptosClient.view({
            payload: {
                function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_verified_token`,
                typeArguments: [],
                functionArguments: [username, tokenSymbol]
            }
        });
        const balanceInBaseUnits = BigInt(result[0] as string);
        const balanceInTokens = Number(balanceInBaseUnits) / Math.pow(10, 8);
        return balanceInTokens.toString();
    }

    private async getUserCreatedTokenBalance(
        username: string,
        tokenOwnerUsername: string,
        tokenSymbol: string,
        aptosClient: Aptos,
        contractAddress: string
    ): Promise<string> {
        const result = await aptosClient.view({
            payload: {
                function: `${contractAddress}::fa_wallet::wallet_fa_balance_for_user_created_token`,
                typeArguments: [],
                functionArguments: [username, tokenOwnerUsername, tokenSymbol]
            }
        });
        const balanceInBaseUnits = BigInt(result[0] as string);
        const balanceInTokens = Number(balanceInBaseUnits) / Math.pow(10, 8);
        return balanceInTokens.toString();
    }

    private async transferMoveToken(
        params: WalletTransferParams,
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string
    ): Promise<any> {
        const amountInBaseUnits = BigInt(Math.floor(Number(params.amount) * Math.pow(10, 8)));
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

        const committedTx = await aptosClient.signAndSubmitTransaction({
            signer: movementAccount,
            transaction: tx,
        });

        return await aptosClient.waitForTransaction({
            transactionHash: committedTx.hash,
            options: { timeoutSecs: 30, checkSuccess: true }
        });
    }

    private async transferFAToken(
        params: WalletTransferParams,
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string
    ): Promise<any> {
        const amountInBaseUnits = BigInt(Math.floor(Number(params.amount) * Math.pow(10, 8)));
        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${contractAddress}::transfer_fa::transfer_token_by_tuser_id_and_symbol`,
                typeArguments: [],
                functionArguments: [
                    params.username,
                    params.tokenOwnerUsername || params.username,
                    params.tokenSymbol,
                    new AccountAddress(this.hexStringToUint8Array(params.recipient)),
                    amountInBaseUnits.toString()
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

    private hexStringToUint8Array(hexString: string): Uint8Array {
        const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
        const pairs = cleanHex.match(/[\dA-F]{2}/gi);
        if (!pairs) {
            throw new Error('Invalid hex string');
        }
        return new Uint8Array(pairs.map(s => parseInt(s, 16)));
    }

    private async stage_execute(params: WalletTransferParams): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
        action?: string;
        balance?: string;
        isVerifiedToken?: boolean;
        needsTokenOwner?: boolean;
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
                // First check if user has a wallet
                const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                
                // If we're just checking wallet existence
                if (!params.tokenSymbol) {
                    return {
                        success: true,
                        userWalletAddress,
                        action: "WALLET_CHECKED"
                    };
                }

                // If we're checking token type
                if (!params.amount && !params.recipient) {
                    if (params.tokenSymbol.toUpperCase() === 'MOVE') {
                        const balance = await this.getWalletBalance(params.username, aptosClient, contractAddress);
                        return {
                            success: true,
                            balance,
                            action: "MOVE_BALANCE_CHECKED"
                        };
                    }

                    const isVerified = await this.checkTokenVerification(params.tokenSymbol, aptosClient, contractAddress);
                    if (isVerified) {
                        const balance = await this.getVerifiedTokenBalance(params.username, params.tokenSymbol, aptosClient, contractAddress);
                        return {
                            success: true,
                            isVerifiedToken: true,
                            balance,
                            action: "TOKEN_VERIFIED"
                        };
                    } else if (params.tokenOwnerUsername) {
                        const balance = await this.getUserCreatedTokenBalance(
                            params.username,
                            params.tokenOwnerUsername,
                            params.tokenSymbol,
                            aptosClient,
                            contractAddress
                        );
                        return {
                            success: true,
                            isVerifiedToken: false,
                            balance,
                            action: "USER_TOKEN_CHECKED"
                        };
                    } else {
                        return {
                            success: true,
                            isVerifiedToken: false,
                            needsTokenOwner: true,
                            action: "NEEDS_TOKEN_OWNER"
                        };
                    }
                }

                // If we have all parameters, execute transfer
                if (params.amount && params.recipient) {
                    let result;
                    if (params.tokenSymbol.toUpperCase() === 'MOVE') {
                        result = await this.transferMoveToken(params, aptosClient, movementAccount, contractAddress);
                    } else {
                        result = await this.transferFAToken(params, aptosClient, movementAccount, contractAddress);
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
                }

                return {
                    success: false,
                    error: "Missing required parameters",
                    action: "INVALID_PARAMETERS"
                };

            } catch (error) {
                if (error.message?.includes("0x51001")) {
                    return {
                        success: false,
                        error: "You don't have a wallet registered yet. Would you like to create one?",
                        action: "WALLET_REQUIRED"
                    };
                }
                throw error;
            }
        } catch (error) {
            elizaLogger.error("WalletTransferPlugin: Error:", error);
            return {
                success: false,
                error: error.message,
                action: "EXECUTION_FAILED"
            };
        }
    }

    private registerActions() {
        const transferAction: IKeywordAction = {
            name: "transfer_token",
            description: "Transfer MOVE or FA tokens to another user",
            examples: [
                "@radhemfeulb69 transfer 100 MOVE to @user",
                "@radhemfeulb69 send 50 BTC to @recipient",
                "@radhemfeulb69 transfer 20 TEST from @owner to @user",
                "@radhemfeulb69 send tokens to @user",
                "@radhemfeulb69 transfer to @recipient"
            ],
            requiredParameters: [],
            action: async (tweet: Tweet, runtime: IAgentRuntime) => {
                const text = tweet.text.toLowerCase();
                
                // Initial parsing of the transfer request
                const extractTokenSymbol = (text: string): string | null => {
                    // Common verified tokens (case-insensitive)
                    const commonTokens = new Set(['move', 'btc', 'eth', 'usdt', 'usdc', 'dai']);
                    
                    // First try to match exact common tokens
                    const commonTokenMatch = text.match(/\b(move|btc|eth|usdt|usdc|dai)\b/i);
                    if (commonTokenMatch) {
                        return commonTokenMatch[1].toUpperCase();
                    }
                    
                    // Then try to match token pattern with $ prefix
                    const tokenWithPrefixMatch = text.match(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/i);
                    if (tokenWithPrefixMatch) {
                        return tokenWithPrefixMatch[1].toUpperCase();
                    }
                    
                    // Finally try to match token-like words
                    const tokenWordMatch = text.match(/\b([A-Za-z][A-Za-z0-9]{1,9})\b/i);
                    if (tokenWordMatch) {
                        const candidate = tokenWordMatch[1].toUpperCase();
                        // Exclude common words that might be mistaken for tokens
                        const excludedWords = new Set(['TOKEN', 'COIN', 'SEND', 'TRANSFER', 'TO', 'FROM']);
                        if (!excludedWords.has(candidate)) {
                            return candidate;
                        }
                    }
                    
                    return null;
                };

                const token = extractTokenSymbol(text);

                const amountMatch = text.match(/\b(\d+(\.\d+)?)\b/);
                const recipientMatch = text.match(/@(\w+)/g)?.filter(mention => 
                    mention.toLowerCase() !== `@${runtime.getSetting("TWITTER_USERNAME")?.toLowerCase()}`
                )[0];
                const ownerMatch = text.match(/from\s+@(\w+)/i);

                // Step 1: Check if user has a custodial wallet
                const walletCheck = await this.stage_execute({
                    username: tweet.username,
                    tokenSymbol: undefined,
                    tweetId: tweet.id
                });

                if (!walletCheck.success || walletCheck.action === "WALLET_REQUIRED") {
                    return {
                        response: "You don't have a wallet yet. Reply 'create wallet' to create one.",
                        action: "PROMPT_REGISTRATION"
                    };
                }

                // Step 2: Check if token is specified
                if (!token) {
                    return {
                        response: "What token would you like to transfer?",
                        action: "COLLECT_TOKEN"
                    };
                }

                // Step 3: Token Type and Balance Check
                const tokenCheck = await this.stage_execute({
                    username: tweet.username,
                    tokenSymbol: token,
                    tokenOwnerUsername: ownerMatch ? ownerMatch[1] : undefined,
                    tweetId: tweet.id
                });

                // Handle token-specific cases
                if (token === 'MOVE') {
                    if (!tokenCheck.balance || Number(tokenCheck.balance) === 0) {
                        return {
                            response: `Your MOVE balance is insufficient. Please top up your wallet with MOVE tokens:\n${walletCheck.userWalletAddress}`,
                            action: "INSUFFICIENT_BALANCE"
                        };
                    }
                } else {
                    if (tokenCheck.isVerifiedToken) {
                        if (!tokenCheck.balance || Number(tokenCheck.balance) === 0) {
                            return {
                                response: `Your ${token} balance is insufficient. Please top up your wallet with ${token} tokens.`,
                                action: "INSUFFICIENT_BALANCE"
                            };
                        }
                    } else if (tokenCheck.needsTokenOwner) {
                        if (!ownerMatch) {
                            return {
                                response: `${token} is a user-created token. Please provide the token owner's username (e.g., "transfer ${token} from @owner").`,
                                action: "COLLECT_TOKEN_OWNER"
                            };
                        } else if (!tokenCheck.balance || Number(tokenCheck.balance) === 0) {
                            return {
                                response: `Your ${token} balance from @${ownerMatch[1]} is insufficient.`,
                                action: "INSUFFICIENT_BALANCE"
                            };
                        }
                    }
                }

                // Parallel Check 1: Validate recipient
                if (!recipientMatch) {
                    return {
                        response: "Who would you like to transfer the tokens to? (Please provide their Twitter username)",
                        action: "COLLECT_RECIPIENT"
                    };
                }

                // Check if recipient has a wallet
                const recipientUsername = recipientMatch.replace('@', '');
                const recipientWalletCheck = await this.stage_execute({
                    username: recipientUsername,
                    tokenSymbol: undefined,
                    tweetId: tweet.id
                });

                if (!recipientWalletCheck.success || recipientWalletCheck.action === "WALLET_REQUIRED") {
                    return {
                        response: `@${recipientUsername} doesn't have a wallet yet. They need to create one first by replying 'create wallet'.`,
                        action: "RECIPIENT_NO_WALLET"
                    };
                }

                // Parallel Check 2: Validate amount
                if (!amountMatch) {
                    const balanceMsg = tokenCheck.balance ? `\nYour current balance is ${tokenCheck.balance} ${token}` : "";
                    return {
                        response: `How many ${token} tokens would you like to transfer?${balanceMsg}`,
                        action: "COLLECT_AMOUNT"
                    };
                }

                const amount = amountMatch[1];
                if (isNaN(Number(amount)) || Number(amount) <= 0) {
                    return {
                        response: "Please provide a valid positive number for the amount to transfer.",
                        action: "INVALID_AMOUNT"
                    };
                }

                // If all checks pass, execute the transfer
                const transferParams: WalletTransferParams = {
                    username: tweet.username,
                    tokenSymbol: token,
                    tokenOwnerUsername: ownerMatch ? ownerMatch[1] : undefined,
                    amount: amount,
                    recipient: recipientUsername,
                    tweetId: tweet.id
                };

                const result = await this.stage_execute(transferParams);

                if (result.success) {
                    const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting];
                    const explorerUrl = `${MOVEMENT_EXPLORER_URL}/${result.transactionId}?network=${network.explorerNetwork}`;
                    
                    return {
                        response: `✅ Transfer successful!\n\nAmount: ${amount} ${token}\nTo: ${recipientMatch}\n\nView transaction: ${explorerUrl}`,
                        action: "TRANSFER_SUCCESSFUL"
                    };
                } else {
                    // Detailed error handling
                    let errorMessage = "Transfer failed. ";
                    if (result.error?.includes("0x13001")) {
                        errorMessage += "Insufficient balance for the transfer.";
                    } else if (result.error?.includes("0x51001")) {
                        errorMessage += "Wallet not found. Please create a wallet first.";
                    } else {
                        errorMessage += result.error || "Please try again.";
                    }
                    
                    return {
                        response: errorMessage,
                        action: "TRANSFER_FAILED"
                    };
                }
            }
        };

        this.registerAction(transferAction);
    }
} 