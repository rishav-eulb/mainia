import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
    generateText,
    ModelClass,
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

const PARAMETER_EXTRACTION_TEMPLATE = `
You are an AI assistant helping to extract token creation parameters from user messages.
Analyze both the current message and conversation history to identify the following parameters:

Required Parameters:
1. symbol: Token symbol/ticker (2-10 characters)
2. name: Token name (1-50 characters)

Optional Parameters:
3. supply: Initial token supply (numeric value, can include M/K suffixes)
4. projectUrl: Project website URL (must be valid URL)

Note: 
- If a user explicitly mentions they don't want to provide an optional parameter (using words like "no", "none", "don't have", etc.), mark it as explicitly declined
- When a single word is provided and could be both symbol and name, use it for both if it meets the criteria
- For supply, recognize variations like "100 million", "100M", "100 M", etc.

Conversation history:
{{history}}

Current message:
{{message}}

Return a JSON object with the following structure:
{
    "extracted": {
        "symbol": "extracted symbol or null if not found",
        "name": "extracted name or null if not found",
        "supply": "extracted supply or null if not found",
        "projectUrl": "extracted URL or null if not found"
    },
    "confidence": {
        "symbol": "HIGH/MEDIUM/LOW",
        "name": "HIGH/MEDIUM/LOW",
        "supply": "HIGH/MEDIUM/LOW",
        "projectUrl": "HIGH/MEDIUM/LOW"
    },
    "foundInCurrentMessage": {
        "symbol": true/false,
        "name": true/false,
        "supply": true/false,
        "projectUrl": true/false
    },
    "explicitlyDeclined": {
        "supply": true/false,
        "iconUrl": true/false,
        "projectUrl": true/false
    }
}

Consider both the conversation history and current message, but prioritize values found in the current message.
If a parameter appears multiple times, use the most recent mention.
Only include parameters that are clearly mentioned. For others, use null.
`;

interface ParameterProcessResult {
    params?: Map<string, string>;
    needsInput?: boolean;
    response?: string;
    parameterName?: string;
}

export class TokenCreationPlugin implements IKeywordPlugin {
    readonly name = "token-creation";
    readonly description = "Plugin for creating and minting new tokens";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];
    private readonly DEFAULT_SUPPLY = "100000000"; // 100M
    private readonly DECIMALS = 8; // 10^8
    private conversationHistory: Map<string, string[]> = new Map();
    private readonly MAX_HISTORY = 5; // Keep last 5 messages for context

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

    private updateConversationHistory(userId: string, message: string) {
        let history = this.conversationHistory.get(userId) || [];
        history.push(message);
        // Keep only the last MAX_HISTORY messages
        if (history.length > this.MAX_HISTORY) {
            history = history.slice(-this.MAX_HISTORY);
        }
        this.conversationHistory.set(userId, history);
    }

    private getConversationHistory(userId: string): string[] {
        return this.conversationHistory.get(userId) || [];
    }

    private async extractParameters(message: string, userId: string): Promise<{
        extracted: {
            symbol: string | null;
            name: string | null;
            supply: string | null;
            projectUrl: string | null;
        };
        confidence: {
            symbol: string;
            name: string;
            supply: string;
            projectUrl: string;
        };
        foundInCurrentMessage: {
            symbol: boolean;
            name: boolean;
            supply: boolean;
            projectUrl: boolean;
        };
        explicitlyDeclined: {
            supply: boolean;
            iconUrl: boolean;
            projectUrl: boolean;
        };
    }> {
        const history = this.getConversationHistory(userId);
        const context = PARAMETER_EXTRACTION_TEMPLATE
            .replace('{{history}}', history.join('\n'))
            .replace('{{message}}', message);
        
        const result = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL
        });

        try {
            return JSON.parse(result);
        } catch (error) {
            elizaLogger.error("Error parsing parameter extraction result:", error);
            return {
                extracted: { symbol: null, name: null, supply: null, projectUrl: null },
                confidence: { symbol: 'LOW', name: 'LOW', supply: 'LOW', projectUrl: 'LOW' },
                foundInCurrentMessage: { symbol: false, name: false, supply: false, projectUrl: false },
                explicitlyDeclined: { supply: false, iconUrl: false, projectUrl: false }
            };
        }
    }

    private validateSymbol(symbol: string): boolean {
        return /^[A-Z0-9]{2,10}$/.test(symbol.toUpperCase());
    }

    private validateName(name: string): boolean {
        return name.length >= 1 && name.length <= 50;
    }

    private validateSupply(supply: string): boolean {
        if (!supply) return true; // Optional
        const num = Number(supply.replace(/[MK]/g, ''));
        return !isNaN(num) && num > 0;
    }

    private validateProjectUrl(url: string): boolean {
        if (!url) return true; // Optional
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    private cleanSymbol(symbol: string): string {
        return symbol.replace(/^\$/, '').toUpperCase();
    }

    private normalizeSupply(supply: string): string {
        if (!supply) return this.DEFAULT_SUPPLY;
        
        // Handle "X million" format
        if (supply.toLowerCase().includes('million')) {
            const num = parseFloat(supply.toLowerCase().split('million')[0].trim());
            return (num * 1000000).toString();
        }
        
        if (supply.endsWith('M')) {
            return (Number(supply.slice(0, -1)) * 1000000).toString();
        } else if (supply.endsWith('K')) {
            return (Number(supply.slice(0, -1)) * 1000).toString();
        }
        return supply;
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

    private async processParameters(tweet: Tweet, params: Map<string, string>): Promise<ParameterProcessResult> {
        // Update conversation history with the current message
        this.updateConversationHistory(tweet.userId, tweet.text || "");

        // Extract parameters from both current message and history
        const extractionResult = await this.extractParameters(tweet.text || "", tweet.userId);
        const extracted = extractionResult.extracted;
        const confidence = extractionResult.confidence;
        const foundInCurrentMessage = extractionResult.foundInCurrentMessage;
        const explicitlyDeclined = extractionResult.explicitlyDeclined;

        // Initialize parameters map with any existing params
        const finalParams = new Map<string, string>(params);

        // If this is a direct response to a parameter prompt, use it for the last requested parameter
        const lastPrompt = this.getConversationHistory(tweet.userId)[1]; // Get the bot's last message
        if (lastPrompt?.includes("What should be the token symbol?") && tweet.text) {
            const symbol = tweet.text.trim().toUpperCase();
            if (this.validateSymbol(symbol)) {
                finalParams.set('symbol', symbol);
                if (!finalParams.get('name')) {
                    finalParams.set('name', symbol); // Use symbol as name if name not provided
                }
            }
        } else if (lastPrompt?.includes("What should be the token name?") && tweet.text) {
            const name = tweet.text.trim();
            if (this.validateName(name)) {
                finalParams.set('name', name);
            }
        }

        // Handle case where the same word could be both symbol and name
        if (extracted.symbol && !extracted.name && 
            this.validateSymbol(extracted.symbol) && 
            this.validateName(extracted.symbol)) {
            extracted.name = extracted.symbol;
            confidence.name = confidence.symbol;
            foundInCurrentMessage.name = foundInCurrentMessage.symbol;
        }

        // Prioritize parameters found in the current message with high confidence
        if (extracted.symbol && foundInCurrentMessage.symbol && confidence.symbol === 'HIGH') {
            finalParams.set('symbol', this.cleanSymbol(extracted.symbol));
        } else if (extracted.symbol && confidence.symbol === 'HIGH') {
            finalParams.set('symbol', this.cleanSymbol(extracted.symbol));
        }
        
        if (extracted.name && foundInCurrentMessage.name && confidence.name === 'HIGH') {
            finalParams.set('name', extracted.name);
        } else if (extracted.name && confidence.name === 'HIGH') {
            finalParams.set('name', extracted.name);
        }

        // Handle optional parameters
        if (extracted.supply && foundInCurrentMessage.supply && confidence.supply === 'HIGH') {
            finalParams.set('supply', this.normalizeSupply(extracted.supply));
        } else if (extracted.supply && confidence.supply === 'HIGH') {
            finalParams.set('supply', this.normalizeSupply(extracted.supply));
        } else if (explicitlyDeclined.supply) {
            finalParams.set('supply', this.DEFAULT_SUPPLY);
        }

        // Check required parameters and prompt for missing ones
        if (!finalParams.get('symbol')) {
            return {
                needsInput: true,
                response: "What should be the token symbol? (2-10 characters, e.g., TEST or $TEST)",
                parameterName: 'symbol'
            };
        }

        if (!finalParams.get('name')) {
            return {
                needsInput: true,
                response: "What should be the token name?",
                parameterName: 'name'
            };
        }

        // Prompt for optional parameters if not provided or explicitly declined
        if (!finalParams.has('supply') && !explicitlyDeclined.supply) {
            return {
                needsInput: true,
                response: "What should be the initial supply? (default: 100M)",
                parameterName: 'supply'
            };
        }

        // Prompt for icon URL if not provided
        if (!finalParams.has('iconUrl') && !explicitlyDeclined.iconUrl) {
            return {
                needsInput: true,
                response: "Would you like to add an icon URL for your token? (Reply with the URL or 'no')",
                parameterName: 'iconUrl'
            };
        }

        // Prompt for project URL if not provided
        if (!finalParams.has('projectUrl') && !explicitlyDeclined.projectUrl) {
            return {
                needsInput: true,
                response: "Would you like to add a project website URL? (Reply with the URL or 'no')",
                parameterName: 'projectUrl'
            };
        }

        return { params: finalParams };
    }

    public async stage_execute(params: TokenCreationParams): Promise<{
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
                    validator: (value: string) => this.validateSymbol(value),
                    extractorTemplate: "Look for a token symbol that is 2-10 characters long, may start with $"
                },
                {
                    name: "name",
                    prompt: "What should be the token name?",
                    validator: (value: string) => this.validateName(value),
                    extractorTemplate: "Look for a token name that follows the symbol"
                },
                {
                    name: "supply",
                    prompt: "What should be the initial supply? (default: 100M)",
                    validator: (value: string) => this.validateSupply(value),
                    optional: true,
                    extractorTemplate: "Look for a number followed by M (millions) or K (thousands)"
                },
                {
                    name: "iconUrl",
                    prompt: "What's the icon URL? (optional)",
                    validator: (value: string) => this.validateProjectUrl(value),
                    optional: true,
                    extractorTemplate: "Look for an image URL starting with http:// or https://"
                },
                {
                    name: "projectUrl",
                    prompt: "What's the project website? (optional)",
                    validator: (value: string) => this.validateProjectUrl(value),
                    optional: true,
                    extractorTemplate: "Look for a URL starting with http:// or https://"
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                const result = await this.processParameters(tweet, params);
                
                // If we need more input, return the prompt
                if (result.needsInput) {
                    return {
                        response: result.response,
                        action: "NEED_INPUT",
                        data: { parameterName: result.parameterName }
                    };
                }

                // Continue with token creation using result.params
                const creationParams: TokenCreationParams = {
                    username: tweet.username,
                    symbol: result.params.get('symbol') || '',
                    name: result.params.get('name') || '',
                    supply: result.params.get('supply') || this.DEFAULT_SUPPLY,
                    iconUrl: result.params.get('iconUrl'),
                    projectUrl: result.params.get('projectUrl')
                };

                const executionResult = await this.stage_execute(creationParams);
                
                if (executionResult.success) {
                    const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                    const network = MOVEMENT_NETWORK_CONFIG[networkSetting];
                    const explorerUrl = `${MOVEMENT_EXPLORER_URL}/${executionResult.transactionId}?network=${network.explorerNetwork}`;
                    
                    return {
                        response: `✅ Token created successfully!\n\nToken: ${creationParams.symbol} (${creationParams.name})\nSupply: ${Number(creationParams.supply).toLocaleString()} tokens\n${creationParams.iconUrl ? `Icon: ${creationParams.iconUrl}\n` : ''}${creationParams.projectUrl ? `Project: ${creationParams.projectUrl}\n` : ''}View transaction: ${explorerUrl}`,
                        data: { transactionId: executionResult.transactionId },
                        action: "TOKEN_CREATED"
                    };
                } else if (executionResult.action === "WALLET_REQUIRED") {
                    return {
                        response: executionResult.error + "\nUse '@radhemfeulb69 create wallet' to create one.",
                        action: "ERROR"
                    };
                } else {
                    return {
                        response: executionResult.error || "Token creation failed. Please try again later.",
                        action: "ERROR"
                    };
                }
            }
        };

        this.registerAction(createTokenAction);
    }
} 