import { Tweet } from "agent-twitter-client";
import { 
    IAgentRuntime, 
    elizaLogger,
    generateText,
    ModelClass
} from "@elizaos/core";
import { ClientBase } from "../../base";
import { 
    IOrchestratorState, 
    IPluginManager, 
    IIntentAnalysis,
    ORCHESTRATOR_MESSAGE_TEMPLATE,
    IPluginDefinition,
    IOrchestratorContext,
    IOrchestratorResponse,
    ORCHESTRATOR_RESPONSE_TEMPLATE
} from "./types";

export class Orchestrator {
    private states: Map<string, IOrchestratorState> = new Map();
    private pluginManagers: Map<string, IPluginManager> = new Map();
    private pluginDefinitions: IPluginDefinition[] = [];
    private readonly MAX_CONTEXT_MESSAGES = 8;
    private readonly CONFIDENCE_THRESHOLD = 0.7;

    constructor(
        private client: ClientBase,
        private runtime: IAgentRuntime
    ) {}

    public registerPluginManager(manager: IPluginManager, definition: IPluginDefinition) {
        this.pluginManagers.set(definition.name, manager);
        this.pluginDefinitions.push(definition);
        elizaLogger.info(`Registered plugin manager: ${definition.name}`);
    }

    private getOrCreateState(userId: string): IOrchestratorState {
        let state = this.states.get(userId);
        if (!state) {
            state = {
                userId,
                conversationContext: [],
                currentIntent: undefined,
                activePlugin: undefined
            };
            this.states.set(userId, state);
        }
        return state;
    }

    private updateConversationContext(state: IOrchestratorState, message: string, isUser: boolean) {
        state.conversationContext.push(`${isUser ? 'User' : 'Bot'}: ${message}`);
        if (state.conversationContext.length > this.MAX_CONTEXT_MESSAGES) {
            state.conversationContext = state.conversationContext.slice(-this.MAX_CONTEXT_MESSAGES);
        }
    }

    private async recognizeIntent(tweet: Tweet, state: IOrchestratorState): Promise<IIntentAnalysis> {
        try {
            const pluginsContext = this.pluginDefinitions.map(def => `
                Plugin: ${def.name}
                Intents: ${def.intents.join(', ')}
                Required Parameters: ${def.requiredParams.join(', ')}
                Optional Parameters: ${def.optionalParams.join(', ')}
                Examples:
                ${def.examples.map(ex => `- ${ex}`).join('\n')}
            `).join('\n\n');

            const context = ORCHESTRATOR_MESSAGE_TEMPLATE
                .replace('{{conversationContext}}', state.conversationContext.join('\n'))
                .replace('{{message}}', tweet.text || '')
                .replace('{{availablePlugins}}', pluginsContext);

            const result = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE
            });

            try {
                const analysis = JSON.parse(result) as IIntentAnalysis;
                
                // Convert extractedParams to Map if it's a plain object
                if (analysis.extractedParams && !(analysis.extractedParams instanceof Map)) {
                    analysis.extractedParams = new Map(Object.entries(analysis.extractedParams));
                }

                return analysis;
            } catch (parseError) {
                elizaLogger.error("Error parsing intent analysis:", parseError);
                return {
                    intent: '',
                    confidence: 0,
                    extractedParams: new Map(),
                    error: 'Failed to parse intent analysis'
                };
            }
        } catch (error) {
            elizaLogger.error("Error in intent recognition:", error);
            return {
                intent: '',
                confidence: 0,
                extractedParams: new Map(),
                error: error instanceof Error ? error.message : 'Unknown error in intent recognition'
            };
        }
    }

    private async generateResponse(
        state: IOrchestratorState,
        intent: string,
        collectedParams: Map<string, string>,
        missingParams: string[]
    ): Promise<string> {
        const template = ORCHESTRATOR_RESPONSE_TEMPLATE
            .replace('{{conversationContext}}', state.conversationContext.join('\n'))
            .replace('{{intent}}', intent)
            .replace('{{collectedParams}}', JSON.stringify(Object.fromEntries(collectedParams)))
            .replace('{{missingParams}}', JSON.stringify(missingParams));

        const result = await generateText({
            runtime: this.runtime,
            context: template,
            modelClass: ModelClass.LARGE
        });

        try {
            const response = JSON.parse(result);
            return response.response;
        } catch (error) {
            elizaLogger.error("Error parsing response:", error);
            return "I'm processing your request. Could you please provide more information?";
        }
    }

    public async handleMessage(
        tweet: Tweet,
        context?: IOrchestratorContext
    ): Promise<IOrchestratorResponse> {
        try {
            elizaLogger.info("Orchestrator: Starting message handling", {
                tweetId: tweet.id,
                username: tweet.username,
                hasContext: !!context
            });

            const state = this.getOrCreateState(tweet.userId);
            if (context?.conversationThread) {
                elizaLogger.debug("Orchestrator: Updating conversation context from thread", {
                    messageCount: context.conversationThread.messages.length
                });
                state.conversationContext = context.conversationThread.messages;
            }
            this.updateConversationContext(state, tweet.text || '', true);

            // If we have an active plugin, forward the message to it first
            if (state.currentIntent && state.activePlugin) {
                elizaLogger.info("Orchestrator: Forwarding to active plugin", {
                    plugin: state.activePlugin,
                    intent: state.currentIntent
                });

                const activeManager = this.pluginManagers.get(state.activePlugin);
                if (!activeManager) {
                    elizaLogger.error("Orchestrator: Active plugin not found", {
                        plugin: state.activePlugin
                    });
                    // Reset state if plugin not found
                    state.currentIntent = undefined;
                    state.activePlugin = undefined;
                    return {
                        response: "Something went wrong. Please try your request again.",
                        error: 'Active plugin not found'
                    };
                }

                const result = await activeManager.handleMessage(tweet, state);
                
                elizaLogger.debug("Orchestrator: Active plugin response", {
                    plugin: state.activePlugin,
                    needsMoreInput: result.needsMoreInput,
                    hasError: !!result.error,
                    readyToExecute: result.readyToExecute,
                    collectedParamsCount: result.collectedParams?.size
                });

                if (result.error) {
                    elizaLogger.warn("Orchestrator: Active plugin returned error", {
                        plugin: state.activePlugin,
                        error: result.error
                    });
                    // Reset state on error
                    state.currentIntent = undefined;
                    state.activePlugin = undefined;
                    return {
                        response: result.error,
                        error: result.error
                    };
                }

                if (result.readyToExecute) {
                    elizaLogger.info("Orchestrator: Active plugin ready to execute", {
                        plugin: state.activePlugin,
                        intent: state.currentIntent,
                        paramsCount: result.collectedParams?.size
                    });
                    // Reset state after successful execution
                    const response = {
                        response: "Ready to execute your request.",
                        action: 'EXECUTE',
                        intent: state.currentIntent,
                        params: result.collectedParams
                    };
                    state.currentIntent = undefined;
                    state.activePlugin = undefined;
                    return response;
                }

                if (result.needsMoreInput) {
                    elizaLogger.debug("Orchestrator: Active plugin needs more input", {
                        plugin: state.activePlugin,
                        nextParameter: result.nextParameter
                    });

                    const response = result.prompt || "Processing your request...";
                    this.updateConversationContext(state, response, false);
                    state.lastResponse = response;
                    state.lastParameterPrompt = result.nextParameter;

                    return { response };
                }

                // If we get here, something unexpected happened
                elizaLogger.warn("Orchestrator: Unexpected plugin response state", {
                    plugin: state.activePlugin,
                    result
                });
                return {
                    response: "I'm not sure how to proceed. Could you please try your request again?",
                    error: "Unexpected plugin response state"
                };
            }

            // No active plugin/intent, analyze the message for intent
            elizaLogger.info("Orchestrator: No active intent/plugin, analyzing message");
            const analysis = await this.recognizeIntent(tweet, state);
            
            elizaLogger.debug("Orchestrator: Intent analysis result", {
                intent: analysis.intent,
                confidence: analysis.confidence,
                error: analysis.error,
                paramsCount: analysis.extractedParams?.size
            });

            if (analysis.error) {
                elizaLogger.warn("Orchestrator: Intent analysis error", {
                    error: analysis.error
                });
                const response = await this.generateResponse(
                    state,
                    'error',
                    new Map(),
                    []
                );
                return {
                    response,
                    error: analysis.error
                };
            }

            if (analysis.confidence < this.CONFIDENCE_THRESHOLD) {
                elizaLogger.warn("Orchestrator: Low confidence in intent recognition", {
                    confidence: analysis.confidence,
                    threshold: this.CONFIDENCE_THRESHOLD
                });
                const response = await this.generateResponse(
                    state,
                    'low_confidence',
                    new Map(),
                    []
                );
                return {
                    response,
                    error: 'Low confidence in intent recognition'
                };
            }

            // Find the plugin that can handle this intent
            const plugin = Array.from(this.pluginManagers.entries())
                .find(([_, manager]) => manager.canHandle(analysis.intent));

            if (!plugin) {
                elizaLogger.warn("Orchestrator: No plugin found for intent", {
                    intent: analysis.intent,
                    availablePlugins: Array.from(this.pluginManagers.keys())
                });
                const response = await this.generateResponse(
                    state,
                    'no_plugin',
                    new Map(),
                    []
                );
                return {
                    response,
                    error: 'No plugin found for intent'
                };
            }

            elizaLogger.info("Orchestrator: Found plugin for intent", {
                plugin: plugin[0],
                intent: analysis.intent
            });

            // Set the active plugin and intent
            state.currentIntent = analysis.intent;
            state.activePlugin = plugin[0];

            // Handle the intent with the plugin manager
            elizaLogger.debug("Orchestrator: Forwarding to plugin manager", {
                plugin: plugin[0],
                intent: analysis.intent
            });
            const result = await plugin[1].handleIntent(analysis.intent, tweet);
            
            elizaLogger.debug("Orchestrator: Plugin manager response", {
                plugin: plugin[0],
                needsMoreInput: result.needsMoreInput,
                hasError: !!result.error,
                readyToExecute: result.readyToExecute,
                collectedParamsCount: result.collectedParams?.size
            });

            if (result.error) {
                elizaLogger.warn("Orchestrator: Plugin manager returned error", {
                    plugin: plugin[0],
                    error: result.error
                });
                // Reset state on error
                state.currentIntent = undefined;
                state.activePlugin = undefined;
                const response = await this.generateResponse(
                    state,
                    analysis.intent,
                    result.collectedParams || new Map(),
                    []
                );
                return {
                    response,
                    error: result.error
                };
            }

            if (result.readyToExecute) {
                elizaLogger.info("Orchestrator: Plugin ready to execute", {
                    plugin: plugin[0],
                    intent: analysis.intent,
                    paramsCount: result.collectedParams?.size
                });
                // Reset state after successful execution
                const response = await this.generateResponse(
                    state,
                    analysis.intent,
                    result.collectedParams || new Map(),
                    []
                );
                state.currentIntent = undefined;
                state.activePlugin = undefined;
                return {
                    response,
                    action: 'EXECUTE',
                    intent: analysis.intent,
                    params: result.collectedParams
                };
            }

            elizaLogger.debug("Orchestrator: Plugin needs more input", {
                plugin: plugin[0],
                nextParameter: result.nextParameter
            });

            const response = await this.generateResponse(
                state,
                analysis.intent,
                result.collectedParams || new Map(),
                [result.nextParameter || '']
            );
            this.updateConversationContext(state, response, false);
            state.lastResponse = response;
            state.lastParameterPrompt = result.nextParameter;

            return { response };

        } catch (error) {
            elizaLogger.error("Orchestrator: Error in message handling", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            return {
                response: "An error occurred while processing your request. Please try again.",
                error: error instanceof Error ? error.message : 'Unknown error in message handling'
            };
        }
    }

    public async getLastIntent(userId: string): Promise<string | undefined> {
        const state = this.states.get(userId);
        return state?.currentIntent;
    }
} 