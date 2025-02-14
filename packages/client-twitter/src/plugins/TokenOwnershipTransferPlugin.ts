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
import { MOVEMENT_NETWORK_CONFIG, DEFAULT_NETWORK, MOVEMENT_EXPLORER_URL } from "../constants";

export interface TokenOwnershipTransferParams {
    username: string;
    symbol?: string;        // Token symbol/ticker (required for symbol-based transfer)
    tokenAddress?: string;  // Token address (required for address-based transfer)
    recipient: string;      // New owner's address
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
                    params.recipient,   // to
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
                    params.recipient,    // to
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
                "@radhemfeulb69 transfer token 0x789... ownership to 0x123..."
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
                    name: "recipient",
                    prompt: "Please provide the new owner's wallet address (must start with 0x)",
                    validator: (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value)
                }
                
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("TokenOwnershipTransferPlugin: Processing transfer with params:", Object.fromEntries(params));
                
                const recipient = params.get("recipient");
                const tokenIdentifier = params.get("tokenIdentifier");
                
                // Determine if tokenIdentifier is a symbol or address
                const isAddress = tokenIdentifier.startsWith("0x");
                
                const transferParams: TokenOwnershipTransferParams = {
                    username: tweet.username,
                    recipient,
                    ...(isAddress ? { tokenAddress: tokenIdentifier } : { symbol: tokenIdentifier })
                };

                const result = await this.stage_execute(transferParams);

                if (result.success) {
                    const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                    const explorerUrl = `${MOVEMENT_EXPLORER_URL}/${result.transactionId}?network=${network.explorerNetwork}`;
                    
                    return {
                        response: `✅ Token ownership transfer successful!\n\nToken: ${isAddress ? 'Token at ' + tokenIdentifier : tokenIdentifier}\nNew Owner: ${recipient}\n\nView transaction: ${explorerUrl}`,
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
                        response: result.error || "Ownership transfer failed. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(transferAction);
    }
} 