import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime, 
    type Memory, 
    type Content,
    composeContext,
    generateText,
    ModelClass,
    stringToUuid,
    getEmbeddingZeroVector,
    elizaLogger
} from "@elizaos/core";
import { ClientBase } from "../base";

// Interface for parameter requirements
// what is valid parameter for? Is it required?
export interface IParameterRequirement {
    name: string;
    prompt: string;
    validator?: (value: string, runtime?: IAgentRuntime) => Promise<boolean>;
    extractorTemplate?: string; // Template for parameter extraction
}

// Interface for defining an action that can be triggered by keywords

// can we use IKeywordPlugin instead of IKeywordAction?
export interface IKeywordAction {
    name: string;           // Name of the action
    description: string;    // Description of what the action does
    examples: string[];     // Example phrases that indicate this action
    requiredParameters?: IParameterRequirement[];  // Parameters needed for this action
    action: (tweet: Tweet, runtime: IAgentRuntime, collectedParams?: Map<string, string>) => Promise<{
        response: string;  // The response to send back
        data?: any;       // Any additional data from the action
        action?: string;  // The action to take
    }>;
}

// Interface for keyword plugins
export interface IKeywordPlugin {
    name: string;
    description: string;
    initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void>;
    getActions(): IKeywordAction[];
    registerAction(action: IKeywordAction): void;
    handleTweet?(tweet: Tweet, runtime: IAgentRuntime): Promise<{
        response?: string;
        data?: any;
        action?: string;
    }>;
}

interface PendingAction {
    actionHandler: IKeywordAction;
    collectedParams: Map<string, string>;
    lastPromptTime: number;
    userId: string;
    roomId: string;
    conversationContext: string[];
    attempts: number;
    lastParameterPrompt?: string;
    clarificationCount: number;
}

const intentRecognitionTemplate = `
# Task: Determine if the user's message indicates intent to perform a specific action or is a normal conversation.

Available Actions:
{{availableActions}}

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Analyze if the user's message indicates they want to perform one of the available actions
2. Consider both explicit mentions and implicit intentions
3. Look for contextual clues and previous conversation history
4. Return your response in this JSON format:
{
    "hasIntent": boolean,
    "actionName": "string or null",
    "confidence": "HIGH/MEDIUM/LOW",
    "reasoning": "Brief explanation of the decision",
}

Only respond with the JSON, no other text.`;

export class KeywordActionPlugin {
    private plugins: Map<string, IKeywordPlugin> = new Map();
    private actions: IKeywordAction[] = [];
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private pendingActions: Map<string, PendingAction> = new Map();
    private TIMEOUT_MS = 5 * 60 * 1000;
    private MAX_ATTEMPTS = 7;
    private MAX_CLARIFICATIONS = 4;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        // Cleanup expired pending actions periodically
        setInterval(() => this.cleanupExpiredActions(), 60000);
    }

    private cleanupExpiredActions() {
        const now = Date.now();
        for (const [userId, pending] of this.pendingActions.entries()) {
            if (now - pending.lastPromptTime > this.TIMEOUT_MS) {
                this.pendingActions.delete(userId);
            }
        }
    }

    // Register a new keyword plugin
    public async registerPlugin(plugin: IKeywordPlugin): Promise<void> {
        await plugin.initialize(this.client, this.runtime);
        this.plugins.set(plugin.name, plugin);
        
        // Register all actions from the plugin
        const actions = plugin.getActions();
        actions.forEach(action => this.registerAction(action));
        
        elizaLogger.info("KeywordActionPlugin: Registered plugin:", {
            name: plugin.name,
            description: plugin.description,
            actionCount: actions.length
        });
    }

    // Get plugin by name
    public getPlugin(name: string): IKeywordPlugin | undefined {
        return this.plugins.get(name);
    }

    // Get all registered plugins
    public getPlugins(): IKeywordPlugin[] {
        return Array.from(this.plugins.values());
    }

    // Register a new keyword action
    public registerAction(action: IKeywordAction): void {
        this.actions.push(action);
        elizaLogger.info("KeywordActionPlugin: Registered action:", {
            name: action.name,
            description: action.description
        });
    }

    // Get action by name
    getActionByName(name: string): IKeywordAction | null {
        return this.actions.find(action => action.name === name) || null;
    }

    // Get all registered actions
    public getActions(): IKeywordAction[] {
        return this.actions;
    }

    
    //TODO: To add conversation context to the Memory 

    private async recognizeIntent(tweet: Tweet, conversationContext: string[] = []): Promise<any> {
        const availableActions = this.actions.map(a => 
            `${a.name}: ${a.description}\nExample phrases: ${a.examples.join(", ")}\nRequired parameters: ${(a.requiredParameters || []).map(p => p.name).join(", ")}`
        ).join("\n\n");

        elizaLogger.info("KeywordActionPlugin: Starting intent recognition", {
            tweetText: tweet.text,
            contextLength: conversationContext.length
        });

        const memory: Memory = {
            id: stringToUuid(tweet.id + "-intent"),
            userId: stringToUuid(tweet.userId),
            agentId: this.runtime.agentId,
            roomId: stringToUuid(tweet.id),
            content: { text: tweet.text || "" },
            embedding: getEmbeddingZeroVector(),
            createdAt: Date.now()
        };

        const state = await this.runtime.composeState(memory, {
            availableActions,
            userMessage: tweet.text,
            conversationContext: conversationContext.join("\n")
        });

        const context = composeContext({
            state,
            template: intentRecognitionTemplate
        });

        elizaLogger.info("KeywordActionPlugin: Sending intent recognition prompt", {
            template: intentRecognitionTemplate,
            userMessage: tweet.text
        });

        const response = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.MEDIUM,
            verifiableInference: true
        });

        elizaLogger.info("KeywordActionPlugin: Received model response for intent recognition", {
            rawResponse: response
        });

        try {
            const result = JSON.parse(response);
            elizaLogger.info("KeywordActionPlugin: Parsed intent recognition result", {
                parsedResult: result
            });
            

            
         return result;
        } catch (error) {
            elizaLogger.error('KeywordActionPlugin: Error parsing intent recognition response:', {
                error: error instanceof Error ? error.message : String(error),
                response
            });
            return null;
        }
    }

    private async extractParameter(
        paramReq: IParameterRequirement,
        tweet: Tweet,
        conversationContext: string[]
    ): Promise<any> {
        try {
            elizaLogger.info("KeywordActionPlugin: Starting parameter extraction", {
                paramName: paramReq.name,
                tweetText: tweet.text
            });

            const template = paramReq.extractorTemplate ;
            
            const memory: Memory = {
                id: stringToUuid(tweet.id + "-param"),
                userId: stringToUuid(tweet.userId),
                agentId: this.runtime.agentId,
                roomId: stringToUuid(tweet.id),
                content: { text: tweet.text || "" },
                embedding: getEmbeddingZeroVector(),
                createdAt: Date.now()
            };

            const state = await this.runtime.composeState(memory, {
                parameterName: paramReq.name,
                parameterDescription: paramReq.prompt,
                userMessage: tweet.text,
                conversationContext: conversationContext.join("\n"),
                agentName: this.client.twitterConfig.TWITTER_USERNAME,
                twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
                bio: "A bot that helps with token transfers and other actions"
            });

            const context = composeContext({
                state,
                template
            });

            elizaLogger.info("KeywordActionPlugin: Sending parameter extraction prompt", {
                template,
                paramName: paramReq.name,
                userMessage: tweet.text
            });

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
                verifiableInference: true
            });

            elizaLogger.info("KeywordActionPlugin: Received model response for parameter extraction", {
                paramName: paramReq.name,
                rawResponse: response
            });

            try {
                const result = JSON.parse(response);
                elizaLogger.info("KeywordActionPlugin: Parsed parameter extraction result", {
                    paramName: paramReq.name,
                    parsedResult: result
                });
                
                // If we need clarification but have asked too many times, try best effort
                if (result.clarificationNeeded && result.alternativeValues?.length > 0) {
                    const pendingAction = this.pendingActions.get(tweet.userId);
                    if (pendingAction && pendingAction.clarificationCount >= this.MAX_CLARIFICATIONS) {
                        result.extracted = true;
                        result.value = result.alternativeValues[0];
                        result.clarificationNeeded = false;
                        elizaLogger.info("KeywordActionPlugin: Using best effort value after max clarifications", {
                            paramName: paramReq.name,
                            value: result.value
                        });
                    }
                }
                
                return result;
            } catch (error) {
                elizaLogger.error("KeywordActionPlugin: Error parsing parameter extraction response:", {
                    error: error instanceof Error ? error.message : String(error),
                    paramName: paramReq.name,
                    response
                });
                return {
                    extracted: false,
                    value: null,
                    confidence: "LOW",
                    clarificationNeeded: true,
                    suggestedPrompt: paramReq.prompt,
                    reasoning: "Failed to parse parameter extraction response"
                };
            }
        } catch (error) {
            elizaLogger.error("KeywordActionPlugin: Error during parameter extraction:", {
                error: error instanceof Error ? error.message : String(error),
                paramName: paramReq.name
            });
            return {
                extracted: false,
                value: null,
                confidence: "LOW",
                clarificationNeeded: true,
                suggestedPrompt: paramReq.prompt,
                reasoning: "Error during parameter extraction"
            };
        }
    }

    // Process a tweet and check for keyword actions
    async processTweet(tweet: Tweet): Promise<{
        hasAction: boolean;
        action?: string;
        response?: string;
        data?: any;
        needsMoreInput?: boolean;
    }> {
        // Fall back to standard keyword action processing
        const userId = tweet.userId;

        // If no ongoing session then try the plugins
        if(!this.pendingActions.has(userId)) {
            for (const plugin of this.plugins.values()) {
                if (plugin.handleTweet) {
                    try {
                        const result = await plugin.handleTweet(tweet, this.runtime);
                        if (result.response || result.action) {
                            return {
                                hasAction: true,
                                action: result.action,
                                response: result.response,
                                data: result.data
                            };
                        }
                    } catch (error) {
                        elizaLogger.error(`Error in plugin ${plugin.name} handleTweet:`, error);
                    }
                }
            }
        }
       
        if (!this.pendingActions.has(userId)) {
            const intent = await this.recognizeIntent(tweet);
            elizaLogger.debug("KeywordActionPlugin: Intent recognition result:", intent);
            
            if (intent?.hasIntent && intent?.actionName && intent.confidence !== 'LOW') {
               const actionHandler = this.actions.find(a => a.name === intent.actionName);
               elizaLogger.debug("KeywordActionPlugin: Found action handler:", actionHandler?.name);
                if (actionHandler) {
                // Initialize new action with extracted parameters
                    const collectedParams = new Map<string, string>();


                // Start parameter collection with a natural response
                    this.pendingActions.set(userId, {
                        actionHandler,
                        collectedParams,
                        lastPromptTime: Date.now(),
                        userId,
                        roomId: stringToUuid(tweet.id),
                        conversationContext: [`User: ${tweet.text}`],
                        attempts: 0,
                        clarificationCount: 0
                    });

                }
            }
        }

        let pendingAction = this.pendingActions.get(userId);       

        if (pendingAction) {
            pendingAction.conversationContext.push(`User: ${tweet.text}`);
            pendingAction.lastPromptTime = Date.now();
            pendingAction.attempts++;

            // Check if we've exceeded max attempts
            if (pendingAction.attempts > this.MAX_ATTEMPTS) {
                this.pendingActions.delete(userId);
                return {
                    hasAction: true,
                    response: "I'm having trouble understanding. Let's start over - could you rephrase your request?",
                };
            }

            // Try to extract missing parameters
            for (const paramReq of pendingAction.actionHandler.requiredParameters || []) {
                if (!pendingAction.collectedParams.has(paramReq.name)) {
                    const extraction = await this.extractParameter(
                        paramReq,
                        tweet,
                        pendingAction.conversationContext
                    );

                    elizaLogger.info("KeywordActionPlugin: Extraction result:", {
                        extraction,
                        key: paramReq.name
                    });

                    if ((extraction?.extracted || extraction?.optional) && extraction?.confidence !== 'LOW') {
                        if (!paramReq.validator || (await paramReq.validator(extraction.value, this.runtime))) {

                            elizaLogger.info("KeywordActionPlugin: Extraction validation:", {
                                extraction,
                                key: paramReq.name
                            });
                            pendingAction.collectedParams.set(paramReq.name, extraction.value);
                            pendingAction.conversationContext.push(
                                `Bot: ${extraction.suggestedPrompt || `Great! I got the ${paramReq.name}.`}`
                            );
                            continue;
                        } else {
                            pendingAction.clarificationCount++;
                            if (pendingAction.clarificationCount <= this.MAX_CLARIFICATIONS) {
                                const prompt = extraction.suggestedPrompt || paramReq.prompt;
                                if (prompt !== pendingAction.lastParameterPrompt) {
                                    pendingAction.lastParameterPrompt = prompt;
                                    return {
                                        hasAction: true,
                                        response: prompt,
                                        needsMoreInput: true
                                    };
                                }
                            }
                        }
                    }

                    // Handle clarification needs
                    if (extraction?.clarificationNeeded) {
                        pendingAction.clarificationCount++;
                        if (pendingAction.clarificationCount <= this.MAX_CLARIFICATIONS) {
                            const prompt = extraction.suggestedPrompt || paramReq.prompt;
                            if (prompt !== pendingAction.lastParameterPrompt) {
                                pendingAction.lastParameterPrompt = prompt;
                                return {
                                    hasAction: true,
                                    response: prompt,
                                    needsMoreInput: true
                                };
                            }
                        }
                    }

                    // If we couldn't extract and haven't asked too many times, ask for it
                    return {
                        hasAction: true,
                        response: paramReq.prompt,
                        needsMoreInput: true
                    };
                }
            }

            // Execute action with all parameters
            try {
                const result = await pendingAction.actionHandler.action(
                    tweet,
                    this.runtime,
                    pendingAction.collectedParams
                );
                this.pendingActions.delete(userId);
                return {
                    hasAction: true,
                    response: result.response,
                    data: result.data,
                    action: result.action
                };
            } catch (error) {
                console.error('Error executing action:', error);
                this.pendingActions.delete(userId);
                return {
                    hasAction: true,
                    response: "I encountered an error while processing your request. Could you try again?"
                };
            }
        }

        return {
            hasAction: false
        }
    }


}