import { Tweet } from "agent-twitter-client";
import { IAgentRuntime, elizaLogger, generateText, ModelClass } from "@elizaos/core";
import { ClientBase } from "../../base";
import { TokenTransferPlugin } from "../TokenTransferPlugin";
import { IPluginManager, IPendingAction, IOrchestratorState, IPluginManagerResponse } from "../orchestrator/types";

const TOKEN_TRANSFER_TEMPLATE = `
You are analyzing a user message to extract token transfer parameters.

Current conversation:
{{conversationContext}}

Last prompted parameter: {{lastParameterPrompt}}
User message: {{message}}

Required parameters:
- recipient (wallet address starting with 0x or @username)
- amount (number of tokens to transfer)
- token (token symbol or address)

Parameter validation rules:
- recipient: Must be a valid wallet address (0x...) or Twitter username (@...)
- amount: Must be a positive number
- token: Must be a valid token symbol (2-10 chars) or address (0x...)

Task: Extract ONLY the currently prompted parameter value from the message.
Focus on extracting: {{lastParameterPrompt}}

Return JSON:
{
    "extractedParameter": {
        "name": "parameter_name",
        "value": "extracted_value",
        "confidence": 0.0-1.0,
        "reasoning": "explanation of how the value was extracted"
    },
    "isValid": true/false,
    "needsMoreInput": true/false,
    "nextPrompt": "natural language prompt if needed",
    "normalizedValue": "standardized form of the value"
}

Only return the JSON object, no other text.`;

interface ParameterAnalysis {
    extractedParameter: {
        name: string;
        value: string;
        confidence: number;
        reasoning: string;
    };
    isValid: boolean;
    needsMoreInput: boolean;
    nextPrompt?: string;
    normalizedValue?: string;
}

export class TokenTransferPluginManager implements IPluginManager {
    private pendingActions: Map<string, IPendingAction> = new Map();
    private readonly MAX_ATTEMPTS = 3;
    private readonly CONFIDENCE_THRESHOLD = 0.8;

    constructor(
        private client: ClientBase,
        private runtime: IAgentRuntime,
        private plugin: TokenTransferPlugin
    ) {}

    public canHandle(intent: string): boolean {
        return intent.toLowerCase().includes('transfer') || 
               intent.toLowerCase().includes('send');
    }

    private getOrCreatePendingAction(userId: string, intent: string): IPendingAction {
        let pending = this.pendingActions.get(userId);
        if (!pending) {
            pending = {
                userId,
                intent,
                collectedParams: new Map(),
                requiredParams: new Set(['recipient', 'amount', 'token']),
                optionalParams: new Set([]),
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
        const context = TOKEN_TRANSFER_TEMPLATE
            .replace('{{conversationContext}}', pending.conversationContext.join('\n'))
            .replace('{{lastParameterPrompt}}', targetParam || 'none')
            .replace('{{message}}', tweet.text || '');

        try {
            const result = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
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

            elizaLogger.debug('Parameter analysis:', analysis);

            if (analysis.extractedParameter.confidence >= this.CONFIDENCE_THRESHOLD) {
                const { name, value } = analysis.extractedParameter;
                const normalizedValue = analysis.normalizedValue || value;

                // Additional validation for empty values
                if (!value || value.trim() === '') {
                    return {
                        parameterName: name,
                        isValid: false,
                        nextPrompt: "I couldn't extract a valid value. Could you please provide it more clearly?"
                    };
                }

                return {
                    parameterName: name,
                    value: normalizedValue,
                    isValid: analysis.isValid,
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

    private getDefaultPrompt(paramName: string): string {
        switch (paramName) {
            case 'recipient':
                return "Who would you like to send tokens to? (Provide a wallet address or Twitter username)";
            case 'amount':
                return "How many tokens would you like to send?";
            case 'token':
                return "Which token would you like to send? (Provide a token symbol or address)";
            default:
                return "What would you like to do next?";
        }
    }

    private getNextRequiredParameter(pending: IPendingAction): string | undefined {
        // Check required parameters first
        for (const param of pending.requiredParams) {
            if (!pending.collectedParams.has(param)) {
                return param;
            }
        }
        return undefined;
    }

    public async handleIntent(intent: string, tweet: Tweet): Promise<IPluginManagerResponse> {
        elizaLogger.info("TokenTransferPluginManager: Handling new intent", {
            intent,
            tweetId: tweet.id,
            username: tweet.username
        });

        const pending = this.getOrCreatePendingAction(tweet.userId, intent);
        pending.conversationContext.push(`User: ${tweet.text || ''}`);

        elizaLogger.debug("TokenTransferPluginManager: Processing initial parameters", {
            userId: tweet.userId,
            conversationLength: pending.conversationContext.length
        });

        const paramResult = await this.processParameter(tweet, pending);
        
        elizaLogger.debug("TokenTransferPluginManager: Parameter processing result", {
            parameterName: paramResult.parameterName,
            hasValue: !!paramResult.value,
            isValid: paramResult.isValid
        });

        if (paramResult.value) {
            pending.collectedParams.set(paramResult.parameterName, paramResult.value);
            elizaLogger.debug("TokenTransferPluginManager: Collected parameter", {
                parameter: paramResult.parameterName,
                value: paramResult.value
            });
        }

        const nextParam = this.getNextRequiredParameter(pending);
        const nextParamName = nextParam || 'unknown';
        
        elizaLogger.info("TokenTransferPluginManager: Intent handling result", {
            needsMoreInput: !!nextParam,
            nextParameter: nextParamName,
            collectedParamsCount: pending.collectedParams.size
        });

        return {
            needsMoreInput: !!nextParam,
            nextParameter: nextParamName,
            prompt: paramResult.nextPrompt || this.getDefaultPrompt(nextParamName),
            collectedParams: pending.collectedParams
        };
    }

    public async handleMessage(tweet: Tweet, state: IOrchestratorState): Promise<IPluginManagerResponse> {
        elizaLogger.info("TokenTransferPluginManager: Handling message", {
            tweetId: tweet.id,
            username: tweet.username,
            currentIntent: state.currentIntent
        });

        const pending = this.getOrCreatePendingAction(tweet.userId, state.currentIntent || '');
        pending.conversationContext.push(`User: ${tweet.text || ''}`);
        pending.attempts++;

        elizaLogger.debug("TokenTransferPluginManager: Processing message", {
            userId: tweet.userId,
            attempts: pending.attempts,
            maxAttempts: pending.maxAttempts,
            conversationLength: pending.conversationContext.length
        });

        if (pending.attempts > pending.maxAttempts) {
            elizaLogger.warn("TokenTransferPluginManager: Max attempts exceeded", {
                userId: tweet.userId,
                attempts: pending.attempts
            });
            this.pendingActions.delete(tweet.userId);
            return {
                needsMoreInput: false,
                error: "Too many attempts. Please start over with your request."
            };
        }

        const lastPromptedParam = state.lastParameterPrompt || 'unknown';
        elizaLogger.debug("TokenTransferPluginManager: Processing parameter", {
            lastPromptedParam,
            userId: tweet.userId
        });

        const paramResult = await this.processParameter(tweet, pending, lastPromptedParam);

        elizaLogger.debug("TokenTransferPluginManager: Parameter processing result", {
            parameterName: paramResult.parameterName,
            hasValue: !!paramResult.value,
            isValid: paramResult.isValid
        });

        if (paramResult.isValid && paramResult.value) {
            pending.collectedParams.set(paramResult.parameterName, paramResult.value);
            elizaLogger.debug("TokenTransferPluginManager: Collected valid parameter", {
                parameter: paramResult.parameterName,
                value: paramResult.value
            });
            
            const nextParam = this.getNextRequiredParameter(pending);
            if (!nextParam) {
                elizaLogger.info("TokenTransferPluginManager: All parameters collected, executing transfer", {
                    collectedParamsCount: pending.collectedParams.size
                });
                // All parameters collected, execute the action
                try {
                    const result = await this.plugin.stage_execute({
                        username: tweet.username || '',
                        recipient: pending.collectedParams.get('recipient') || '',
                        amount: pending.collectedParams.get('amount') || '',
                        token: pending.collectedParams.get('token') || '',
                        tweetId: tweet.id || ''
                    });

                    elizaLogger.info("TokenTransferPluginManager: Transfer execution completed", {
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
                    elizaLogger.error("TokenTransferPluginManager: Transfer execution failed", {
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined
                    });
                    return {
                        needsMoreInput: false,
                        error: error.message || 'An unknown error occurred'
                    };
                }
            }

            elizaLogger.info("TokenTransferPluginManager: Needs more parameters", {
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

        elizaLogger.debug("TokenTransferPluginManager: Invalid or missing parameter value", {
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
} 