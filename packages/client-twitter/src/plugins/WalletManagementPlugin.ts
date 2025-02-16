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
            // Convert balance from base units to MOVE tokens (assuming 8 decimals)
            const balanceInBaseUnits = BigInt(result[0] as string);
            const balanceInMove = Number(balanceInBaseUnits) / Math.pow(10, 8);
            return balanceInMove.toString();
        } catch (error) {
            elizaLogger.error("Error fetching wallet balance:", {
                error: error instanceof Error ? error.message : String(error),
                username
            });
            throw error;
        }
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

            try {
                // First try to get user's wallet address
                const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                
                if (params.action === 'GET_ADDRESS') {
                    return {
                        success: true,
                        address: userWalletAddress,
                        action: "ADDRESS_RETRIEVED"
                    };
                } else if (params.action === 'GET_BALANCE') {
                    const balance = await this.getWalletBalance(params.username, aptosClient, contractAddress);
                    return {
                        success: true,
                        balance,
                        action: "BALANCE_RETRIEVED"
                    };
                }

                return {
                    success: false,
                    error: "Invalid action specified",
                    action: "INVALID_ACTION"
                };

            } catch (error) {
                // Check if error is due to user not being registered (0x51001)
                if (error.message?.includes("0x51001")) {
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
            description: "Manage user's wallet (get address or balance)",
            examples: [
                "@radhemfeulb69 what is my wallet address",
                "@radhemfeulb69 show my wallet address",
                "@radhemfeulb69 get my wallet balance",
                "@radhemfeulb69 how much MOVE do I have",
                "@radhemfeulb69 check my balance",
                "@radhemfeulb69 create wallet"
            ],
            requiredParameters: [],
            action: async (tweet: Tweet, runtime: IAgentRuntime) => {
                elizaLogger.info("WalletManagementPlugin: Processing wallet action for user:", tweet.username);
                
                const text = tweet.text.toLowerCase();
                const action = text.includes('balance') ? 'GET_BALANCE' : 'GET_ADDRESS';

                const params: WalletParams = {
                    username: tweet.username,
                    action
                };

                const result = await this.stage_execute(params);

                if (result.success) {
                    if (result.address) {
                        return {
                            response: `Your custodial wallet address is:\n${result.address}`,
                            action: "ADDRESS_RETRIEVED"
                        };
                                        } else if (result.balance) {
                            return {
                                response: `Your wallet balance is: ${result.balance} MOVE`,
                                action: "BALANCE_RETRIEVED"
                            };
                    }
                } else if (result.needsRegistration) {
                    return {
                        response: "You don't have a wallet registered yet. Reply 'yes' if you'd like to create one.",
                        action: "PROMPT_REGISTRATION"
                    };
                } else {
                    return {
                        response: result.error || "An error occurred while processing your request.",
                        action: "ERROR"
                    };
                }

                return {
                    response: "Unable to process your request.",
                    action: "ERROR"
                };
            }
        };

        const registrationAction: IKeywordAction = {
            name: "wallet_registration",
            description: "Handle wallet registration confirmation",
            examples: [
                "@radhemfeulb69 yes",
                "@radhemfeulb69 yes create wallet",
                "@radhemfeulb69 yes please",
                "@radhemfeulb69 create wallet"
            ],
            requiredParameters: [],
            action: async (tweet: Tweet, runtime: IAgentRuntime) => {
                elizaLogger.info("WalletManagementPlugin: Processing registration for user:", tweet.username);
                
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

                    const success = await this.createUserWallet(
                        tweet.username,
                        aptosClient,
                        movementAccount,
                        contractAddress
                    );

                    if (success) {
                        // Get the newly created wallet address
                        const address = await this.getUserWalletAddress(tweet.username, aptosClient, contractAddress);
                        return {
                            response: `✅ Wallet created successfully!\n\nYour custodial wallet address is:\n${address}\n\nYou can now top up this wallet to start using MOVE tokens.`,
                            action: "WALLET_CREATED"
                        };
                    } else {
                        return {
                            response: "Failed to create wallet. Please try again later.",
                            action: "WALLET_CREATION_FAILED"
                        };
                    }
                } catch (error) {
                    elizaLogger.error("Error in wallet registration:", error);
                    return {
                        response: "An error occurred while creating your wallet. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(walletAction);
        this.registerAction(registrationAction);
    }
} 