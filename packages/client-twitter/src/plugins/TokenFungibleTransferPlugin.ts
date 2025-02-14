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
import { TokenTransferPlugin } from "./TokenTransferPlugin";
export interface TokenFungibleTransferParams {
    username: string;
    tokenCreator?: string;  // Optional token creator's twitter handle
    symbol?: string;        // Token symbol/ticker (required for symbol-based transfer)
    tokenAddress?: string;  // Token address (required for address-based transfer)
    recipient: string;      // Recipient address
    amount: string;         // Amount to transfer
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
        this.registerActions();
        elizaLogger.info("TokenFungibleTransferPlugin: Initialized");
        this.tokenTransferPlugin = new TokenTransferPlugin();
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
                    params.symbol,                                     // symbol
                    params.recipient,                                  // to
                    BigInt(Number(params.amount) * Math.pow(10, 8))   // amount (converted to base units)
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
                    params.recipient,                                  // to
                    BigInt(Number(params.amount) * Math.pow(10, 8))   // amount (converted to base units)
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
                    result = await this.transferByAddress(aptosClient, movementAccount, contractAddress, params);
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
                "Show me how to transfer",
                "@radhemfeulb69 transfer 100 TEST to 0x123...",
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
                    name: "amount",
                    prompt: "How many tokens would you like to transfer?",
                    validator: (value: string) => {
                        const num = Number(value);
                        return !isNaN(num) && num > 0;
                    }
                },
                {
                    name: "recipient",
                    prompt: "Please provide the recipient's wallet address (must start with 0x)",
                    validator: (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value)
                }
                
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("TokenFungibleTransferPlugin: Processing transfer with params:", Object.fromEntries(params));
                
                const amount = params.get("amount");
                const recipient = params.get("recipient");
                const tokenIdentifier = params.get("tokenIdentifier");

                
                // Determine if tokenIdentifier is a symbol or address
                const isAddress = tokenIdentifier.startsWith("0x");
                
                const transferParams: TokenFungibleTransferParams = {
                    username: tweet.username,
                    recipient,
                    amount,
                    ...(isAddress ? { tokenAddress: tokenIdentifier } : { symbol: tokenIdentifier })
                };

                const result = await this.stage_execute(transferParams);

                if (result.success) {
                    const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                    const explorerUrl = ``;
                    
                    return {
                        response: `✅ Transfer successful!\n\nAmount: ${amount} ${isAddress ? 'tokens' : tokenIdentifier}\nTo: ${recipient}\n\nView transaction: ${explorerUrl}`,
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

        this.registerAction(transferAction);
    }
} 