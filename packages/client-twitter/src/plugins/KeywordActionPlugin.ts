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
    validator?: (value: string) => boolean;
    extractorTemplate?: string; // Template for parameter extraction
    optional?: boolean;        // Whether the parameter is optional
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
    "extractedParams": {
        "paramName": "extractedValue"
    }
}

Only respond with the JSON, no other text.`;

const parameterExtractionTemplate = `
# Task: Extract parameter value from user's message in a conversational context

About {{agentName}} (@{{twitterUserName}}):
{{bio}}

Parameter to extract: {{parameterName}}
Parameter description: {{parameterDescription}}

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider both explicit and implicit mentions in the context
3. Consider common variations and synonyms
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

    private async findExistingActionKey(tweet: Tweet, thread: Tweet[]): Promise<string | null> {
        // Check current tweet
        const currentKey = `${tweet.userId}-${tweet.id}`;
        if (this.pendingActions.has(currentKey)) {
            return currentKey;
        }

        // Check thread
        for (const threadTweet of thread) {
            const threadKey = `${tweet.userId}-${threadTweet.id}`;
            if (this.pendingActions.has(threadKey)) {
                return threadKey;
            }
        }
        return null;
    }
    
    //TODO: To add conversation context to the Memory 

    private async recognizeIntent(tweet: Tweet, conversationContext: string[] = []): Promise<any> {
        const availableActions = this.actions.map(a => 
            `${a.name}: ${a.description}\nExample phrases: ${a.examples.join(", ")}`
        ).join("\n\n");

        

        const memory: Memory = {
            id: stringToUuid(tweet.id + "-intent"),
            userId: stringToUuid(tweet.userId),
            agentId: this.runtime.agentId,
            roomId: stringToUuid(tweet.id),
            content: { text: tweet.text || "",  },
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

        const response = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL
        });

        try {
            return JSON.parse(response);
        } catch (error) {
            console.error('Error parsing intent recognition response:', error);
            return null;
        }
    }

    private async extractParameter(
        paramReq: IParameterRequirement,
        tweet: Tweet,
        conversationContext: string[]
    ): Promise<any> {
        try {
            const template = paramReq.extractorTemplate || parameterExtractionTemplate;
            
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

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
                verifiableInference: true // Use verifiable inference to ensure valid JSON
            });

            try {
                const result = JSON.parse(response);
                
                // If we need clarification but have asked too many times, try best effort
                if (result.clarificationNeeded && result.alternativeValues?.length > 0) {
                    const pendingAction = this.pendingActions.get(tweet.userId);
                    if (pendingAction && pendingAction.clarificationCount >= this.MAX_CLARIFICATIONS) {
                        result.extracted = true;
                        result.value = result.alternativeValues[0];
                        result.clarificationNeeded = false;
                    }
                }
                
                return result;
            } catch (error) {
                elizaLogger.error("Error parsing parameter extraction response:", {
                    error: error.message,
                    response
                });
                // Return a structured error response
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
            elizaLogger.error("Error during parameter extraction:", error);
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
        // First try plugin-specific handlers
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

        // Fall back to standard keyword action processing
        const userId = tweet.userId;
        const pendingAction = this.pendingActions.get(userId);

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

                    if (extraction?.extracted && extraction?.confidence !== 'LOW') {
                        if (!paramReq.validator || paramReq.validator(extraction.value)) {
                            pendingAction.collectedParams.set(paramReq.name, extraction.value);
                            pendingAction.conversationContext.push(
                                `Bot: ${extraction.suggestedPrompt || `Great! I got the ${paramReq.name}.`}`
                            );
                            continue;
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

        // No pending action, try to recognize intent
        const intent = await this.recognizeIntent(tweet);
        elizaLogger.debug("KeywordActionPlugin: Intent recognition result:", intent);
        
        if (intent?.hasIntent && intent?.actionName && intent.confidence !== 'LOW') {
            const actionHandler = this.actions.find(a => a.name === intent.actionName);
            elizaLogger.debug("KeywordActionPlugin: Found action handler:", actionHandler?.name);
            if (actionHandler) {
                // Initialize new action with extracted parameters
                const collectedParams = new Map<string, string>();
                if (intent.extractedParams) {
                    Object.entries(intent.extractedParams).forEach(([key, value]) => {
                        if (value && (!actionHandler.requiredParameters?.find(p => p.name === key)?.validator || 
                            actionHandler.requiredParameters?.find(p => p.name === key)?.validator?.(value as string))) {
                            collectedParams.set(key, value as string);
                        }
                    });
                }

                // If we have all parameters, execute immediately
                if (actionHandler.requiredParameters?.every(p => collectedParams.has(p.name))) {
                    try {
                        const result = await actionHandler.action(tweet, this.runtime, collectedParams);
                        return {
                            hasAction: true,
                            response: result.response,
                            data: result.data,
                            action: result.action
                        };
                    } catch (error) {
                        console.error('Error executing action:', error);
                        return {
                            hasAction: true,
                            response: "I encountered an error while processing your request. Could you try again?"
                        };
                    }
                }

                // Start parameter collection with a natural response
                this.pendingActions.set(userId, {
                    actionHandler,
                    collectedParams,
                    lastPromptTime: Date.now(),
                    userId,
                    roomId: stringToUuid(tweet.id),
                    conversationContext: [`User: ${tweet.text}`],
                    attempts: 1,
                    clarificationCount: 0
                });

                // Use the suggested response from intent recognition if available
                const response = intent.suggestedResponse || 
                    actionHandler.requiredParameters?.find(p => !collectedParams.has(p.name))?.prompt ||
                    "I need some more information to help you with that.";

                return {
                    hasAction: true,
                    response,
                    needsMoreInput: true
                };
            }
        }

        return {
            hasAction: false
        };
    }

//     private async validateTweetIntent(tweet: Tweet, thread: Tweet[]): Promise<{
//         hasIntent: boolean;
//         intentType: "NEW_INTENT" | "CONTINUE_CONVERSATION" | "CANCEL_INTENT" | "NORMAL_CONVERSATION";
//         actionName: string | null;
//         confidence: "HIGH" | "MEDIUM" | "LOW";
//         reasoning: string;
//     }> {
//         // First, try to find if this is part of an existing conversation
//         const existingActionKey = await this.findExistingActionKey(tweet, thread);
//         let existingAction: PendingAction | undefined;
//         if (existingActionKey) {
//             existingAction = this.pendingActions.get(existingActionKey);
//         }

//         const availableActions = this.actions.map(a => 
//             `${a.name}: ${a.description}\nExample phrases: ${a.examples.join(", ")}`
//         ).join("\n\n");

//         // Include the full conversation context from the pending action if it exists
//         const conversationContext = existingAction 
//             ? existingAction.conversationContext.join("\n")
//             : thread.map(t => `${t.username}: ${t.text}`).join("\n");

//         // Get all messages from the same room for better context
//         const roomMessages = await this.runtime.messageManager.getMemoriesByRoomIds({
//             roomIds: [stringToUuid(existingAction?.roomId || tweet.id)],
//             limit: 10  // Get last 10 messages for context
//         });

//         const roomContext = roomMessages
//             .sort((a, b) => a.createdAt - b.createdAt)
//             .map(msg => `${msg.userId}: ${msg.content.text}`)
//             .join("\n");

//         const memory: Memory = {
//             id: stringToUuid(tweet.id + "-intent"),
//             userId: stringToUuid(tweet.userId || ""),
//             agentId: this.runtime.agentId,
//             roomId: stringToUuid(existingAction?.roomId || tweet.id),
//             content: { text: tweet.text || "" },
//             embedding: getEmbeddingZeroVector(),
//             createdAt: Date.now()
//         };

//         const state = await this.runtime.composeState(memory, {
//             availableActions,
//             userMessage: tweet.text,
//             conversationContext,
//             roomContext,
//             currentAction: existingAction ? {
//                 name: existingAction.actionHandler.name,
//                 collectedParams: Object.fromEntries(existingAction.collectedParams),
//                 missingParams: existingAction.actionHandler.requiredParameters
//                     ?.filter(param => !existingAction.collectedParams.has(param.name))
//                     .map(param => param.name) || []
//             } : null
//         });

//         const enhancedIntentTemplate = `
// # Task: Determine if the user's message indicates intent to perform a specific action or is a normal conversation.

// Available Actions:
// {{availableActions}}

// User's message:
// {{userMessage}}

// Previous conversation context:
// {{conversationContext}}

// Room conversation history:
// {{roomContext}}

// ${existingAction ? `
// Current ongoing action:
// - Action: ${existingAction.actionHandler.name}
// - Collected parameters: ${Array.from(existingAction.collectedParams.entries()).map(([key, value]) => `${key}=${value}`).join(', ')}
// - Missing parameters: ${existingAction.actionHandler.requiredParameters
//     ?.filter(param => !existingAction.collectedParams.has(param.name))
//     .map(param => param.name)
//     .join(', ')}
// ` : ''}

// # Instructions:
// 1. Analyze if the user's message indicates they want to perform one of the available actions
// 2. Consider both explicit mentions and implicit intentions
// 3. Look for contextual clues and previous conversation history
// 4. If there's an ongoing action, determine if:
//    - User is providing missing parameters
//    - User wants to cancel the action
//    - User wants to start a new action instead
// 5. Return your response in this JSON format:
// {
//     "hasIntent": boolean,
//     "intentType": "NEW_INTENT" | "CONTINUE_CONVERSATION" | "CANCEL_INTENT" | "NORMAL_CONVERSATION",
//     "actionName": "string or null",
//     "confidence": "HIGH/MEDIUM/LOW",
//     "reasoning": "Brief explanation of the decision",
//     "extractedParams": {
//         "paramName": "extractedValue"
//     }
// }

// Only respond with the JSON, no other text.`;

//         const context = composeContext({
//             state,
//             template: enhancedIntentTemplate
//         });

//         const response = await generateText({
//             runtime: this.runtime,
//             context,
//             modelClass: ModelClass.SMALL
//         });

//         try {
//             return JSON.parse(response);
//         } catch (error) {
//             elizaLogger.error("Error parsing intent validation response:", error);
//             return {
//                 hasIntent: false,
//                 intentType: "NORMAL_CONVERSATION",
//                 actionName: null,
//                 confidence: "LOW",
//                 reasoning: "Error parsing intent validation"
//             };
//         }
//     }
}

// Example usage:
/*
const plugin = new KeywordActionPlugin(client, runtime);

// Register an action
plugin.registerAction({
    name: "weather",
    description: "Get weather information",
    examples: ["What's the weather today?", "How's the weather in New York?"],
    action: async (tweet, runtime) => {
        // Extract location from tweet
        // Call weather API
        // Format response
        return {
            response: "Weather information...",
            data: { temperature: 20, condition: "sunny" }
        };
    }
});

// In your tweet handler:
const result = await plugin.processTweet(tweet);
if (result.hasAction) {
    // Send the response
    await sendTweet(result.response);
} else {
    // Handle normally
    // ...
}
*/ 