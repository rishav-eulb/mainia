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
import { generateText, ModelClass } from "@elizaos/core";

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
                // const userWalletAddress = await this.getUserWalletAddress(params.username, aptosClient, contractAddress);
                // if (!userWalletAddress) {
                //     return {
                //         success: false,
                //         error: "You don't have a wallet registered yet. Please create one first.",
                //         action: "WALLET_REQUIRED"
                //     };
                // }

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
                if (error.message?.includes("0x85001")) {
                    return {
                        success: false,
                        error: "You have already created a token with same ticker. Kindly use another ticker",
                        action: "TOKEN_ALREADY_CREATED"
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

    private cleanSymbol(symbol: string | null | undefined): string {
        if (!symbol) return '';
        // Remove $ if present at the start and convert to uppercase
        return symbol.replace(/^\$/, '').toUpperCase();
    }

    private async extractParameterWithLLM(paramType: string, text: string, runtime: IAgentRuntime): Promise<string> {
        const validationRequirements = {
            symbol: [
                "Must be 2-10 characters long",
                "Should be treated as uppercase",
                "Allowed characters: letters (A-Z), digits (0-9), and optionally a leading '$'",
                "Must contain at least one letter (A-Z)",
                "Cannot be a common generic word like 'TOKEN' or 'COIN' by itself",
                "Should be unique, memorable, and not overly generic"
            ],
            name: [
                "Must be 1-50 characters long (including spaces and basic punctuation)",
                "Must contain at least one letter (A-Z or a-z)",
                "Should be descriptive and unique to represent the token's brand/purpose",
                "Can include letters, numbers, spaces, and basic punctuation",
                "Purely generic names like 'Token' or 'Coin' alone are invalid",
                "Overly long (exceeding 50 characters) or meaningless strings are invalid"
            ],
            supply: [
                "Must represent a valid positive number",
                "Can be written with K (thousand), M (million), or B (billion) suffixes",
                "Can be given in words or digits (e.g. '1 million', '1000000')",
                "Maximum allowed is 1 trillion (1T)",
                "Defaults to '100M' if not specified or if the user explicitly wants the default",
                "Negative, zero, or nonsensical values are invalid"
            ],
            projectUrl: [
                "Must be a valid HTTP or HTTPS URL or a well-formed domain that can be converted into a URL",
                "Must have a legitimate domain with a recognized TLD (e.g. .com, .io, .finance, .xyz)",
                "No localhost, private IPs, or unsupported protocols like ftp://",
                "If the user provides no protocol but a valid domain, prepend 'https://'",
                "If the user explicitly states they have no URL or will provide it later, return 'no'",
                "Must not exceed reasonable length or contain invalid characters"
            ]
        };

        const validationPurpose = {
            symbol: "uniquely identify the token on exchanges and in transactions",
            name: "provide a descriptive and distinctive full name of the token",
            supply: "determine the initial token supply, which directly affects its economics",
            projectUrl: "verify the project's web presence and offer users more information"
        };

        const requirements = validationRequirements[paramType as keyof typeof validationRequirements] || [];
        const purpose = validationPurpose[paramType as keyof typeof validationPurpose] || "";

        const extractionPrompt = `# Parameter Extraction for Token Creation

Context:
You are assisting in extracting and validating parameters needed for token creation on a blockchain platform. The extracted values must meet specific criteria before being passed to a validator.

Parameter Type: ${paramType}

Validation Purpose:
${purpose}

Validation Requirements:
${requirements.map((req, i) => `${i + 1}. ${req}`).join('\n')}

Previous Message Context:
${text}

Extraction Guidelines:
1. Identify the most likely valid candidate for the requested parameter within the user's text.
2. Apply the validation rules above:
   - If it fails any rule, consider the value invalid.
   - For ${paramType}, if the text contains multiple possible candidates, choose the most valid or the first that meets the criteria.
   - For ${paramType}, also allow interpretations like "default supply" -> "" (meaning user wants the default).
   - For ${paramType}, prepend "https://" if the user provided only "domain.tld" without a protocol.
3. Output only the extracted value if valid, or an empty string if invalid or not provided (except for ${paramType} cases where the user says "no URL" -> output "no").
4. Do not include additional text - only return the parameter or the fallback string.
5. Do not return code, explanations, or JSON - just the raw value.

End of Prompt`;

        const extractedValue = await generateText({
            runtime,
            context: extractionPrompt,
            modelClass: ModelClass.MEDIUM
        });

        const cleanValue = extractedValue.trim();
        elizaLogger.info("TokenCreationPlugin: Parameter extraction result", {
            paramType,
            rawValue: extractedValue,
            cleanValue
        });

        // For projectUrl, handle 'no' responses
        if (paramType === 'projectUrl' && cleanValue.toLowerCase() === 'no') {
            elizaLogger.info("TokenCreationPlugin: ProjectUrl extraction - explicit no");
            return 'no';
        }

        // For other parameters, try to clean up any potential formatting
        return cleanValue.replace(/^["']|["']$/g, '').trim();
    }

    private registerActions(): void {
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
                    prompt: "What should be the token symbol? (2-10 characters, e.g., $TEST, use uppercase)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: symbol
Parameter description: Token symbol must be 2-10 characters long and alphanumeric, should have $ prefix, must be uppercase, should start with an alphabet and contain at least one letter.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context
3. Don't trim the extracted paramater.
4. Token symbol can begin with '$' symbol
5. symbol's characters length must be greater than 1 and less than 11.
6. Ignore any keyword token or coin as a symbol
7. Return your response in this JSON format:
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
                    validator: async (value: string, runtime: IAgentRuntime) => {
                        // If the input is already a clean symbol format, use it directly
                        const directInput = value.trim().toUpperCase();
                        if (directInput.length <= 1 || directInput.length > 10) {
                            return false;
                        }
                    
                        // should not be equal to 'TOKEN' or 'COIN'
                        return /^[$]?[A-Z0-9]{2,10}$/.test(directInput) && directInput !== 'TOKEN' && directInput !== 'COIN';

                    }
                },
                {
                    name: "name",
                    prompt: "What should be the token name? (1-50 characters, use a descriptive name)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: name
Parameter description: Token name that is 1-50 characters long, contains letters and optional numbers/spaces. Must be descriptive and not generic.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context    
3. Return your response in this JSON format:
4. Ignore any keyword token or coin as a symbol
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
                    validator: async (value: string | null | undefined, runtime: IAgentRuntime) => {
                        if (!value) return false;
                        
                        const cleanName = value.trim();
                        // Basic validation first
                        if (cleanName.length < 1 || cleanName.length > 50) return false;
                        if (!/[a-zA-Z]/.test(cleanName)) return false;
                        if (/^(token|coin|cryptocurrency)$/i.test(cleanName)) return false;
                        if (!/^[a-zA-Z0-9\s\-_.']+$/.test(cleanName)) return false;

                        // If basic validation passes, we can trust the value
                        elizaLogger.info("TokenCreationPlugin: Name validation successful", {
                            value: cleanName
                        });
                        return true;
                    }
                },
                {
                    name: "supply",
                    prompt: "What should be the initial supply? (e.g., 100M, 1B, 1000K, or say 'no' for default 100M)",
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: supply
Parameter description: Token supply amount in K/M/B format (e.g., '1M', '100K', '1.5B'). Default is 100M if not specified.

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context
3. Consider common variations and synonyms
4. Make sure the token supply is a positive number and is less than 1 billion
5. If the user says 'no' or 'nah' or 'nope' or 'not' or 'skip' or 'default', then set response's parameter value as '100M', parameter extracted as true', confidence as 'HIGH', clarification needed as 'false', suggested prompt as 'no', reasoning as 'user said no'
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
                    validator: async (value: string, runtime: IAgentRuntime) => {
                        const extractedValue = await this.extractParameterWithLLM("supply", value, runtime);
                        elizaLogger.info("Extracted supply:", {
                            extractedValue,
                            value
                        });
                        const cleanValue = extractedValue.trim().toLowerCase();
                        if (['no', 'nah', 'nope', 'not', 'skip', 'default'].includes(cleanValue)) return true;
                        if (!cleanValue) return true;

                        const match = cleanValue.match(/^(\d+(?:\.\d+)?)\s*(k|m|b|t)?$/i);
                        if (!match) return false;

                        const [_, num, suffix] = match;
                        const baseNum = parseFloat(num);
                        if (isNaN(baseNum) || baseNum <= 0) return false;

                        const multipliers = {
                            'k': 1000,
                            'm': 1000000,
                            'b': 1000000000,
                            't': 1000000000000
                        };
                        
                        const finalValue = suffix ? baseNum * multipliers[suffix.toLowerCase()] : baseNum;
                        return finalValue <= 1000000000000;
                    }
                },
//                 {
//                     name: "projectUrl",
//                     prompt: "What's the project website? (optional, provide URL or say 'no')",
//                     extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

// Parameter to extract: projectUrl
// Parameter description: Valid project website URL. Must be HTTP/HTTPS, or a valid domain that can be prefixed with https://.

// User's message:
// {{userMessage}}

// Previous conversation context:
// {{conversationContext}}

// # Instructions:
// 1. Extract the value for the specified parameter
// 2. Consider only implicit mentions in the context, starting with 'https://' or 'http://' 
// 3. If the user returns any other responses, then set response's parameter value as 'no', make sure to set parameter extracted as 'true', confidence as 'HIGH', clarification needed as 'false', suggested prompt as 'no', reasoning as 'user said no'
// 4. optional parameter is always true
// 5. Return your response in this JSON format:
// {
//     "extracted": true/false,
//     "value": "extracted_value or null if not found",
//     "confidence": "HIGH/MEDIUM/LOW",
//     "alternativeValues": ["other", "possible", "interpretations"],
//     "clarificationNeeded": true/false,
//     "suggestedPrompt": "A natural way to ask for clarification if needed",
//     "reasoning": "Brief explanation of the extraction logic",
//     "optional": true
// }

// Only respond with the JSON, no other text.`,
//                     validator: async (value: string | null | undefined, runtime: IAgentRuntime) => {
//                         // Handle null/undefined values
//                         if (value === null || value === undefined || value === 'no') return true;
                        
//                         const cleanValue = value.toLowerCase().trim();
//                         elizaLogger.info("TokenCreationPlugin: Validating projectUrl", {
//                             rawValue: value,
//                             cleanValue
//                         });

//                         // Handle explicit "no" responses
//                         if (['no', 'nah', 'nope', 'not', 'skip'].includes(cleanValue)) {
//                             elizaLogger.info("TokenCreationPlugin: ProjectUrl validation - explicit no");
//                             return true;
//                         }

//                         // Handle empty values
//                         if (!cleanValue) {
//                             elizaLogger.info("TokenCreationPlugin: ProjectUrl validation - empty value");
//                             return true;
//                         }

//                         try {
//                             // Try to construct a URL object
//                             const url = new URL(cleanValue);
                            


//                             // Validate hostname
//                             if (!url.hostname.includes('.')) {
//                                 elizaLogger.warn("TokenCreationPlugin: ProjectUrl validation failed - invalid hostname", {
//                                     hostname: url.hostname
//                                 });
//                                 return false;
//                             }

//                             // Check for localhost and private IPs
//                             if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(url.hostname)) {
//                                 elizaLogger.warn("TokenCreationPlugin: ProjectUrl validation failed - localhost/private IP");
//                                 return false;
//                             }

//                             // Check for IP addresses
//                             if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname)) {
//                                 elizaLogger.warn("TokenCreationPlugin: ProjectUrl validation failed - IP address");
//                                 return false;
//                             }

//                             elizaLogger.info("TokenCreationPlugin: ProjectUrl validation successful", {
//                                 url: url.toString()
//                             });
//                             return true;
//                         } catch (error) {
//                             elizaLogger.warn("TokenCreationPlugin: ProjectUrl validation failed - invalid URL", {
//                                 error: error instanceof Error ? error.message : String(error)
//                             });
//                             return false;
//                         }
//                     }
//                 }
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

                // const projectUrl = params.get("projectUrl") !== 'no' ? params.get("projectUrl") : "";
                const projectUrl = "";
                
                
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
