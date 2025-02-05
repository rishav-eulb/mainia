import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime, 
    type Memory, 
    type Content,
    composeContext,
    generateText,
    ModelClass,
    stringToUuid,
    getEmbeddingZeroVector
} from "@elizaos/core";
import { ClientBase } from "../base";

// Interface for parameter requirements
export interface IParameterRequirement {
    name: string;
    prompt: string;
    validator?: (value: string) => boolean;
    extractorTemplate?: string; // Template for parameter extraction
}

// Interface for defining an action that can be triggered by keywords
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

interface PendingAction {
    actionHandler: IKeywordAction;
    collectedParams: Map<string, string>;
    lastPromptTime: number;
    userId: string;
    conversationContext: string[];
}

const intentRecognitionTemplate = `
# Task: Determine if the user's message indicates they want to perform a specific action.

Available Actions:
{{availableActions}}

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions: 
1. Analyze if the user's message indicates they want to perform one of the available actions
2. Consider both explicit mentions and implicit intentions
3. Return your response in this JSON format:
{
    "matchedAction": "action_name or null if no match",
    "confidence": "HIGH/MEDIUM/LOW",
    "missingInfo": ["list", "of", "missing", "information"],
    "extractedParams": {
        "param1": "extracted_value",
        "param2": "extracted_value"
    }
}

Only respond with the JSON, no other text.`;

const parameterExtractionTemplate = `
# Task: Extract parameter value from user's message

Parameter to extract: {{parameterName}}
Parameter description: {{parameterDescription}}

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Return your response in this JSON format:
{
    "extracted": true/false,
    "value": "extracted_value or null if not found",
    "confidence": "HIGH/MEDIUM/LOW"
}

Only respond with the JSON, no other text.`;

export class KeywordActionPlugin {
    private actions: IKeywordAction[] = [];
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private pendingActions: Map<string, PendingAction> = new Map(); // userId -> PendingAction
    private TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes timeout for pending actions

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

    // Register a new keyword action
    registerAction(action: IKeywordAction) {
        this.actions.push(action);
    }

    private async recognizeIntent(tweet: Tweet, conversationContext: string[] = []): Promise<any> {
        const availableActions = this.actions.map(a => 
            `${a.name}: ${a.description}\nExample phrases: ${a.examples.join(", ")}`
        ).join("\n\n");

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
            conversationContext: conversationContext.join("\n")
        });

        const context = composeContext({
            state,
            template
        });

        const response = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL
        });

        try {
            return JSON.parse(response);
        } catch (error) {
            console.error('Error parsing parameter extraction response:', error);
            return null;
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
        const userId = tweet.userId;
        const pendingAction = this.pendingActions.get(userId);

        // Update conversation context
        if (pendingAction) {
            pendingAction.conversationContext.push(`User: ${tweet.text}`);
            pendingAction.lastPromptTime = Date.now();

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
                            pendingAction.conversationContext.push(`Bot: Great! I got the ${paramReq.name}.`);
                            continue;
                        }
                    }

                    // If we couldn't extract this parameter, ask for it
                    return {
                        hasAction: true,
                        response: paramReq.prompt,
                        needsMoreInput: true
                    };
                }
            }

            // If we have all parameters, execute the action
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
                    response: "I encountered an error while processing your request."
                };
            }
        }

        // No pending action, try to recognize intent
        const intent = await this.recognizeIntent(tweet);
        if (intent?.matchedAction && intent.confidence !== 'LOW') {
            const actionHandler = this.actions.find(a => a.name === intent.matchedAction);
            if (actionHandler) {
                // Initialize new action with any extracted parameters
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
                            response: "I encountered an error while processing your request."
                        };
                    }
                }

                // Otherwise, start parameter collection
                this.pendingActions.set(userId, {
                    actionHandler,
                    collectedParams,
                    lastPromptTime: Date.now(),
                    userId,
                    conversationContext: [`User: ${tweet.text}`]
                });

                // Ask for the first missing parameter
                const firstMissingParam = actionHandler.requiredParameters?.find(p => !collectedParams.has(p.name));
                return {
                    hasAction: true,
                    response: firstMissingParam?.prompt || "I need more information to help you with that.",
                    needsMoreInput: true
                };
            }
        }

        // No action matched
        return {
            hasAction: false
        };
    }
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