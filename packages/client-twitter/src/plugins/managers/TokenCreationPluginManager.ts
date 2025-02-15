import { Tweet } from "agent-twitter-client";
import { IAgentRuntime, elizaLogger, generateText, ModelClass } from "@elizaos/core";
import { ClientBase } from "../../base";
import { TokenCreationPlugin, TokenCreationParams } from "../TokenCreationPlugin";
import { 
    IPluginManager, 
    IPendingAction, 
    IOrchestratorState, 
    IPluginManagerResponse,
    PLUGIN_MANAGER_RESPONSE_TEMPLATE,
    IPluginManagerTemplate
} from "../orchestrator/types";

const TOKEN_CREATION_TEMPLATE = `
You are analyzing a user message to extract token creation parameters.

Current conversation:
{{conversationContext}}

Last prompted parameter: {{lastParameterPrompt}}
User message: {{message}}

Required parameters:
- symbol (2-10 alphanumeric characters, all uppercase)
- name (token name, 1-50 characters)

Optional parameters:
- supply (optional, can be a positive number like "100M" for 100 Million)
- iconUrl (optional, can be a valid URL)
- projectUrl (optional, can be a valid URL)

Important:
1. When processing the initial message, extract ALL parameters that are present (symbol, name, supply, etc.)
2. For optional parameters, recognize ANY variation of declining responses including:
   - "no", "none", "nope"
   - "don't want", "don't need", "i don't"
   - "not needed", "not required"
   - Any negative statement indicating the user doesn't want to provide the parameter
3. If a parameter was already collected in a previous message, don't extract it again
4. For supply parameter:
   - Normalize values like "100M", "100 million", "100 M" to the same format (e.g., "100000000")
   - Accept variations like "100 M", "100M", "100 million", "100Million"
5. When {{lastParameterPrompt}} is "none", look for ALL parameters in the message
6. When {{lastParameterPrompt}} specifies a parameter, focus ONLY on that parameter

Return array of JSON objects:
{
    
       "extractedParameter": {
             "name": "parameter_name",
             "value": "extracted_value", // undefined in case of not provided or validation has failed
             "confidence": 0.0-1.0,
             "reasoning": "explanation of how the value was extracted",
             "isValid": true/false,
             "isPresent": true/false
    }
}

Only return the JSON object, no other text.`;

interface ITokenCreationPlugin {
    initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void>;
    stage_execute(params: TokenCreationParams): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
        action?: string;
        userWalletAddress?: string;
    }>;
}

interface ParameterAnalysis {
    extractedParameter: {
        name: string;
        value: string;
        confidence: number;
        reasoning: string;
        isDeclined?: boolean;
    };
    isValid: boolean;
    needsMoreInput: boolean;
    nextPrompt?: string;
    normalizedValue?: string;
}

export class TokenCreationPluginManager implements IPluginManager {
    private pendingActions: Map<string, IPendingAction> = new Map();
    private plugin: ITokenCreationPlugin;
    private readonly MAX_ATTEMPTS = 6;
    private readonly CONFIDENCE_THRESHOLD = 0.8;

    constructor(
        private client: ClientBase,
        private runtime: IAgentRuntime
    ) {
        this.plugin = new TokenCreationPlugin();
        this.plugin.initialize(client, runtime);
    }

    public canHandle(intent: string): boolean {
        return intent.toLowerCase().includes('create token') || 
               intent.toLowerCase().includes('mint token') ||
               intent.toLowerCase().includes('new token');
    }

    private getOrCreatePendingAction(userId: string, intent: string): IPendingAction {
        let pending = this.pendingActions.get(userId);
        if (!pending) {
            pending = {
                userId,
                intent,
                collectedParams: new Map(),
                requiredParams: new Set(['symbol', 'name']),
                optionalParams: new Set(['supply', 'iconUrl', 'projectUrl']),
                conversationContext: [],
                attempts: 0,
                maxAttempts: this.MAX_ATTEMPTS
            };
            this.pendingActions.set(userId, pending);
        }
        return pending;
    }

    private async processParameter(
        tweet: Tweet,
        pending: IPendingAction,
        targetParam?: string
    ): Promise<{
        parameterName: string;
        value?: string;
        isValid: boolean;
        nextPrompt?: string;
    }> {
        const templateData: IPluginManagerTemplate = {
            pluginName: "token-creation",
            requiredParams: Array.from(pending.requiredParams),
            optionalParams: Array.from(pending.optionalParams),
            collectedParams: pending.collectedParams,
            currentParameter: targetParam,
            message: tweet.text || '',
            conversationContext: pending.conversationContext
        };

        try {
            elizaLogger.debug("TokenCreationPluginManager: Processing parameter", {
                targetParam,
                messageText: tweet.text,
                contextLength: pending.conversationContext.length,
                collectedParams: Array.from(pending.collectedParams.keys())
            });

            const result = await generateText({
                runtime: this.runtime,
                context: TOKEN_CREATION_TEMPLATE
                    .replace('{{conversationContext}}', pending.conversationContext.join('\n'))
                    .replace('{{lastParameterPrompt}}', targetParam || 'none')
                    .replace('{{message}}', tweet.text || ''),
                modelClass: ModelClass.LARGE
            });

            let analysis: ParameterAnalysis;
            try {
                analysis = JSON.parse(result);
                
                // Validate the response structure
                if (!analysis?.extractedParameter?.name || 
                    !analysis?.extractedParameter?.value || 
                    typeof analysis.extractedParameter.confidence !== 'number' ||
                    typeof analysis.isValid !== 'boolean') {
                    throw new Error('Invalid response format');
                }

                // Ensure normalizedValue is a string if present
                if (analysis.normalizedValue && typeof analysis.normalizedValue !== 'string') {
                    analysis.normalizedValue = String(analysis.normalizedValue);
                }

                elizaLogger.debug("TokenCreationPluginManager: Parsed parameter analysis", {
                    parameterName: analysis.extractedParameter.name,
                    confidence: analysis.extractedParameter.confidence,
                    isValid: analysis.isValid,
                    isDeclined: analysis.extractedParameter.isDeclined,
                    normalizedValue: analysis.normalizedValue
                });

            } catch (parseError) {
                elizaLogger.error('Error parsing parameter analysis:', {
                    error: parseError,
                    result: result
                });
                return {
                    parameterName: targetParam || 'unknown',
                    isValid: false,
                    nextPrompt: "I couldn't understand that. Could you please try again?"
                };
            }

            if (analysis.extractedParameter.confidence >= this.CONFIDENCE_THRESHOLD) {
                const { name, value, isDeclined } = analysis.extractedParameter;
                const normalizedValue = analysis.normalizedValue || value;

                // Enhanced decline recognition
                const isDeclinedResponse = isDeclined || this.isDeclineResponse(value);

                // Skip if parameter was already collected
                if (pending.collectedParams.has(name)) {
                    elizaLogger.debug("TokenCreationPluginManager: Parameter already collected, skipping", {
                        parameter: name,
                        existingValue: pending.collectedParams.get(name)
                    });
                    return {
                        parameterName: name,
                        value: pending.collectedParams.get(name),
                        isValid: true
                    };
                }

                // For optional parameters, check if it was declined
                if (pending.optionalParams.has(name) && isDeclinedResponse) {
                    elizaLogger.debug("TokenCreationPluginManager: Optional parameter declined", {
                        parameter: name,
                        originalValue: value,
                        isDeclined: isDeclined,
                        isDeclinedResponse: isDeclinedResponse
                    });
                    return {
                        parameterName: name,
                        value: 'no',
                        isValid: true
                    };
                }

                // Additional validation for empty values
                if (!value || value.trim() === '') {
                    return {
                        parameterName: name,
                        isValid: false,
                        nextPrompt: "I couldn't extract a valid value. Could you please provide it more clearly?"
                    };
                }

                // Validate the normalized value
                const isValid = this.validateParameter(name, normalizedValue);
                if (!isValid) {
                    return {
                        parameterName: name,
                        isValid: false,
                        nextPrompt: `${this.getValidationHint(name)} Please try again.`
                    };
                }

                return {
                    parameterName: name,
                    value: normalizedValue,
                    isValid: true,
                    nextPrompt: analysis.needsMoreInput ? analysis.nextPrompt : undefined
                };
            }

            return {
                parameterName: targetParam || 'unknown',
                isValid: false,
                nextPrompt: analysis.nextPrompt || this.getDefaultPrompt(targetParam || 'unknown')
            };
        } catch (error) {
            elizaLogger.error("Error processing parameter:", {
                error: error instanceof Error ? error.message : String(error),
                tweet: tweet.text,
                targetParam
            });
            return {
                parameterName: targetParam || 'unknown',
                isValid: false,
                nextPrompt: "There was an error processing your input. Could you please try again?"
            };
        }
    }

    private validateParameter(name: string, value: string): boolean{
        if (!value) return false;
        
        switch (name) {
            case 'symbol':
                return /^[A-Z0-9]{2,10}$/.test(value);
            case 'name':
                return value.length >= 1 && value.length <= 50;
            case 'supply':
                // Allow "no" for optional parameters
                if (value.toLowerCase() === 'no') return true;
                // Remove commas and spaces, then check if it's a valid number
                const cleanedSupply = value.replace(/[, ]/g, '');
                return /^\d+$/.test(cleanedSupply) && BigInt(cleanedSupply) > 0;
            case 'projectUrl':
                // Allow "no" for optional parameters
                
                try {
                    new URL(value);
                    return true;
                } catch {
                    return false;
                }
            default:
                return true;
        }
    }

    private normalizeParameter(name: string, value: string): string {
        if (!value) return '';
        
        const normalizedValue = value.trim();
        
        switch (name) {
            case 'symbol':
                return normalizedValue.toUpperCase();
            
            case 'supply':
                if (normalizedValue.toLowerCase() === 'no') return 'no';
                
                // Handle suffixes like M, K
                const cleanedValue = normalizedValue.replace(/[, ]/g, '');
                if (/^\d+M$/i.test(cleanedValue)) {
                    const number = cleanedValue.replace(/M$/i, '');
                    return (BigInt(number) * BigInt(1000000)).toString();
                }
                if (/^\d+K$/i.test(cleanedValue)) {
                    const number = cleanedValue.replace(/K$/i, '');
                    return (BigInt(number) * BigInt(1000)).toString();
                }
                if (/^\d+ ?million$/i.test(cleanedValue)) {
                    const number = cleanedValue.replace(/ ?million$/i, '');
                    return (BigInt(number) * BigInt(1000000)).toString();
                }
                if (/^\d+ ?thousand$/i.test(cleanedValue)) {
                    const number = cleanedValue.replace(/ ?thousand$/i, '');
                    return (BigInt(number) * BigInt(1000)).toString();
                }
                return cleanedValue.replace(/[, ]/g, '');
            
            case 'iconUrl': 
            case 'projectUrl':
                const lowerValue = normalizedValue.toLowerCase();
                // Check for various forms of "no"
                if (lowerValue === 'no' || 
                    lowerValue === 'none' || 
                    lowerValue === 'nope' ||
                    lowerValue.includes("don't") ||
                    lowerValue.includes("dont") ||
                    lowerValue.includes("not needed") ||
                    lowerValue.includes("not required")) {
                    return 'no';
                }
                return normalizedValue;
            
            default:
                return normalizedValue;
        }
    }

    private getValidationHint(paramName: string): string {
        switch (paramName) {
            case 'symbol':
                return "Symbol should be 2-10 characters long and contain only uppercase letters and numbers.";
            case 'name':
                return "Name should be between 1 and 50 characters.";
            case 'supply':
                return "Supply should be a positive number. You can use suffixes like 'M' for million or 'K' for thousand.";
            case 'iconUrl': "Please provide a valid URL or say 'no' if you don't want to add one.";
            case 'projectUrl':
                return "Please provide a valid URL or say 'no' if you don't want to add one.";
            default:
                return "Please provide a valid value.";
        }
    }

    private getDefaultPrompt(paramName: string): string {
        switch (paramName) {
            case 'symbol':
                return "What should be the token symbol? It should be 2-10 characters long, like 'BTC' or 'ETH'.";
            case 'name':
                return "What would you like to name your token?";
            case 'supply':
                return "How many tokens would you like to mint initially? (default: 100M)";
            case 'iconUrl':
                return "Would you like to add an icon for your token? Share a URL or say 'no'.";
            case 'projectUrl':
                return "Would you like to add a project website? Share a URL or say 'no'.";
            default:
                return "Please provide the requested information.";
        }
    }

    private getNextRequiredParameter(pending: IPendingAction): string | undefined {
        // Check required parameters first
        for (const param of pending.requiredParams) {
            if (!pending.collectedParams.has(param)) {
                return param;
            }
        }

        // Then check optional parameters
        for (const param of pending.optionalParams) {
            if (!pending.collectedParams.has(param)) {
                return param;
            }
        }

        return undefined;
    }

    public async handleIntent(intent: string, tweet: Tweet): Promise<IPluginManagerResponse> {
        elizaLogger.info("TokenCreationPluginManager: Handling new intent", {
            intent,
            tweetId: tweet.id,
            username: tweet.username
        });

        const pending = this.getOrCreatePendingAction(tweet.userId, intent);
        pending.conversationContext.push(`User: ${tweet.text || ''}`);

        // Process initial message for all parameters
        const initialParams = ['name', 'symbol', 'supply', 'iconUrl', 'projectUrl'];
        let collectedAny = false;

        for (const param of initialParams) {
            const paramResult = await this.processParameter(tweet, pending, param);
            console.log(paramResult);
            if (paramResult.isValid && paramResult.value) {
                pending.collectedParams.set(paramResult.parameterName, paramResult.value);
                collectedAny = true;
                elizaLogger.debug("TokenCreationPluginManager: Collected initial parameter", {
                    parameter: paramResult.parameterName,
                    value: paramResult.value
                });
            }
        }

        const nextParam = this.getNextRequiredParameter(pending);
        const nextParamName = nextParam || 'unknown';

        elizaLogger.info("TokenCreationPluginManager: Intent handling result", {
            needsMoreInput: !!nextParam,
            nextParameter: nextParamName,
            collectedParamsCount: pending.collectedParams.size,
            initialParamsCollected: collectedAny
        });

        return {
            needsMoreInput: !!nextParam,
            nextParameter: nextParamName,
            prompt: this.getDefaultPrompt(nextParamName),
            collectedParams: pending.collectedParams
        };
    }

    public async handleMessage(tweet: Tweet, state: IOrchestratorState): Promise<IPluginManagerResponse> {
        elizaLogger.info("TokenCreationPluginManager: Handling message", {
            tweetId: tweet.id,
            username: tweet.username,
            userId: tweet.userId
        });

        const pending = this.getOrCreatePendingAction(tweet.userId, state.currentIntent || 'CREATE_TOKEN');
        pending.attempts++;

        if (pending.attempts > this.MAX_ATTEMPTS) {
            this.pendingActions.delete(tweet.userId);
            return {
                needsMoreInput: false,
                error: "Maximum attempts exceeded. Please start over."
            };
        }

        const paramResult = await this.processParameter(tweet, pending);

        if (paramResult.isValid && paramResult.value) {
            pending.collectedParams.set(paramResult.parameterName, paramResult.value);
            elizaLogger.debug("TokenCreationPluginManager: Collected valid parameter", {
                parameter: paramResult.parameterName,
                value: paramResult.value
            });
            
            const nextParam = this.getNextRequiredParameter(pending);
            if (!nextParam) {
                elizaLogger.info("TokenCreationPluginManager: All parameters collected, executing token creation", {
                    collectedParamsCount: pending.collectedParams.size
                });
                
                try {
                    // Create params object with required parameters
                    const params: TokenCreationParams = {
                        username: tweet.username,  // Ensure username is from the tweet
                        symbol: pending.collectedParams.get('symbol') || '',
                        name: pending.collectedParams.get('name') || ''
                    };

                    // Only add optional parameters if they have non-empty values
                    const supply = pending.collectedParams.get('supply');
                    if (supply) {
                        params.supply = supply;
                    }

                    const iconUrl = pending.collectedParams.get('iconUrl');
                    if (iconUrl && iconUrl.toLowerCase() !== "no") {
                        params.iconUrl = iconUrl;
                    }

                    const projectUrl = pending.collectedParams.get('projectUrl');
                    if (projectUrl && projectUrl.toLowerCase() !== "no") {
                        params.projectUrl = projectUrl;
                    }

                    const result = await this.plugin.stage_execute(params);

                    elizaLogger.info("TokenCreationPluginManager: Token creation completed", {
                        success: result.success,
                        hasError: !!result.error
                    });

                    this.pendingActions.delete(tweet.userId);
                    return {
                        needsMoreInput: false,
                        readyToExecute: true,
                        collectedParams: pending.collectedParams
                    };
                } catch (error) {
                    elizaLogger.error("TokenCreationPluginManager: Token creation failed", {
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined
                    });
                    return {
                        needsMoreInput: false,
                        error: error.message || 'An unknown error occurred'
                    };
                }
            }

            elizaLogger.info("TokenCreationPluginManager: Needs more parameters", {
                nextParameter: nextParam,
                collectedParamsCount: pending.collectedParams.size
            });

            const nextParamName = nextParam || 'unknown';
            return {
                needsMoreInput: true,
                nextParameter: nextParamName,
                prompt: this.getDefaultPrompt(nextParamName),
                collectedParams: pending.collectedParams
            };
        }

        elizaLogger.debug("TokenCreationPluginManager: Invalid or missing parameter value", {
            parameterName: paramResult.parameterName,
            hasPrompt: !!paramResult.nextPrompt
        });

        const paramName = paramResult.parameterName || 'unknown';
        return {
            needsMoreInput: true,
            nextParameter: paramName,
            prompt: paramResult.nextPrompt || this.getDefaultPrompt(paramName),
            collectedParams: pending.collectedParams
        };
    }

    public async executeCreation(params: Map<string, string>): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
        additionalInfo?: string;
    }> {
        try {
            const result = await this.plugin.stage_execute({
                username: params.get('username'),
                symbol: params.get('symbol'),
                name: params.get('name'),
                supply: params.get('supply') || '',
                iconUrl: params.get('iconUrl') || '',
                projectUrl: params.get('projectUrl') || ''
            });

            if (result.success) {
                return {
                    success: true,
                    transactionId: result.transactionId,
                    additionalInfo: `Token ${params.get('symbol')} created successfully!`
                };
            } else {
                return {
                    success: false,
                    error: result.error || 'Token creation failed'
                };
            }
        } catch (error) {
            elizaLogger.error("Error executing token creation:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error during token creation'
            };
        }
    }

    private isDeclineResponse(value: string): boolean {
        const lowerValue = value.toLowerCase().trim();
        const declinePatterns = [
            /^no$/,
            /^none$/,
            /^nope$/,
            /don'?t\s*(want|need)/i,
            /not\s*(needed|required|necessary)/i,
            /i\s*don'?t/i,
            /^n$/,
            /^no\s*thanks?$/i,
            /^pass$/i,
            /skip\s*it/i
        ];

        return declinePatterns.some(pattern => pattern.test(lowerValue));
    }
} 