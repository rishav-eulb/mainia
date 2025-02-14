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

export interface TokenCreationParams {
    username: string;      // Twitter handle of the creator
    symbol: string;        // Token symbol/ticker
    name: string;         // Token name
    supply?: string;      // Optional supply (defaults to 100M)
    iconUrl?: string;     // Optional icon URL
    projectUrl?: string;  // Optional project URL
}

export class TokenCreationPlugin implements IKeywordPlugin {
    readonly name = "token-creation";
    readonly description = "Plugin for creating and minting new tokens";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];
    private readonly DEFAULT_SUPPLY = "100000000"; // 100M
    private readonly DECIMALS = 8; // 10^8

    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.registerActions();
        elizaLogger.info("TokenCreationPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("TokenCreationPlugin: Registered action:", {
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

    private async createToken(
        aptosClient: Aptos,
        movementAccount: Account,
        contractAddress: string,
        params: TokenCreationParams
    ): Promise<any> {
        // Convert supply to base units (multiply by 10^8)
        const supplyInBaseUnits = BigInt(
            Math.floor(
                Number(params.supply || this.DEFAULT_SUPPLY) * Math.pow(10, this.DECIMALS)
            )
        );

        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${contractAddress}::manage_token::create_token`,
                typeArguments: [],
                functionArguments: [
                    params.username,           // tuser_id
                    params.symbol,             // symbol
                    params.name,               // name
                    supplyInBaseUnits,         // supply
                    params.iconUrl || "",      // icon_url
                    params.projectUrl || "",   // project_url
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

    private async stage_execute(params: TokenCreationParams): Promise<{
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

                // Execute token creation
                const result = await this.createToken(aptosClient, movementAccount, contractAddress, params);

                if (result.success) {
                    return {
                        success: true,
                        transactionId: result.hash,
                        action: "TOKEN_CREATED"
                    };
                } else {
                    return {
                        success: false,
                        error: result.vm_status || "Transaction failed",
                        action: "CREATION_FAILED"
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
            elizaLogger.error("TokenCreationPlugin: Error executing token creation:", {
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

    private validateProjectUrl(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    private cleanSymbol(symbol: string): string {
        // Remove $ if present at the start and convert to uppercase
        return symbol.replace(/^\$/, '').toUpperCase();
    }

    private registerActions() {
        const createTokenAction: IKeywordAction = {
            name: "create_token",
            description: "Create and mint a new token",
            examples: [
                "@radhemfeulb69 create token TEST Token",
                "@radhemfeulb69 create $TEST token Token with supply 1000000",
                "@radhemfeulb69 create token TEST Token supply 1M project https://test.com",
                "@radhemfeulb69 mint new token TEST Token"
            ],
            requiredParameters: [
                {
                    name: "symbol",
                    prompt: "What should be the token symbol? (2-10 characters, e.g., TEST or $TEST)",
                    validator: (value: string) => /^[$]?[A-Z0-9]{2,10}$/.test(value.toUpperCase())
                },
                {
                    name: "name",
                    prompt: "What should be the token name?",
                    validator: (value: string) => value.length >= 1 && value.length <= 50
                },
                {
                    name: "supply",
                    prompt: "What should be the initial supply? (default: 100M)",
                    validator: (value: string) => {
                        if (!value) return true; // Optional
                        const num = Number(value.replace(/[MK]/g, ''));
                        return !isNaN(num) && num > 0;
                    }
                },
                {
                    name: "projectUrl",
                    prompt: "What's the project website? (optional)",
                    validator: (value: string) => {
                        if (!value) return true; // Optional
                        return this.validateProjectUrl(value);
                    }
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("TokenCreationPlugin: Processing token creation with params:", Object.fromEntries(params));
                
                const symbol = this.cleanSymbol(params.get("symbol"));
                const name = params.get("name");
                let supply = params.get("supply") || this.DEFAULT_SUPPLY;
                
                // Handle M/K suffixes in supply
                if (supply.endsWith('M')) {
                    supply = (Number(supply.slice(0, -1)) * 1000000).toString();
                } else if (supply.endsWith('K')) {
                    supply = (Number(supply.slice(0, -1)) * 1000).toString();
                }

                const projectUrl = params.get("projectUrl") || "";
                
                const creationParams: TokenCreationParams = {
                    username: tweet.username,
                    symbol,
                    name,
                    supply,
                    projectUrl
                };

                const result = await this.stage_execute(creationParams);

                if (result.success) {
                    const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                    const explorerUrl = `${MOVEMENT_EXPLORER_URL}/${result.transactionId}?network=${network.explorerNetwork}`;
                    
                    return {
                        response: `✅ Token created successfully!\n\nToken: ${symbol} (${name})\nSupply: ${Number(supply).toLocaleString()} tokens\n${projectUrl ? `Project: ${projectUrl}\n` : ''}View transaction: ${explorerUrl}`,
                        data: { transactionId: result.transactionId },
                        action: "TOKEN_CREATED"
                    };
                } else if (result.action === "WALLET_REQUIRED") {
                    return {
                        response: result.error + "\nUse '@radhemfeulb69 create wallet' to create one.",
                        action: "ERROR"
                    };
                } else {
                    return {
                        response: result.error || "Token creation failed. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(createTokenAction);
    }
} 