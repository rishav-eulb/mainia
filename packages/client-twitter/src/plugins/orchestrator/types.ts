import { Tweet } from "agent-twitter-client";
import { IAgentRuntime } from "@elizaos/core";
import { IConversationThread } from "../../utils/conversation";

export interface IOrchestratorState {
    userId: string;
    currentIntent?: string;
    activePlugin?: string;
    conversationContext: string[];
    lastResponse?: string;
    lastParameterPrompt?: string;
}

export interface IOrchestratorResponse {
    response: string;
    action?: string;
    error?: string;
    intent?: string;
    params?: Map<string, string>;
}

export interface IOrchestratorContext {
    conversationThread: IConversationThread;
    metadata: {
        isNewConversation: boolean;
        lastInteractionTime?: number;
        previousIntent?: string;
    };
}

export interface IPluginManagerResponse {
    needsMoreInput: boolean;
    nextParameter?: string;
    prompt?: string;
    readyToExecute?: boolean;
    collectedParams?: Map<string, string>;
    error?: string;
}

export interface IPluginManager {
    handleIntent(intent: string, tweet: Tweet): Promise<IPluginManagerResponse>;
    handleMessage(tweet: Tweet, state: IOrchestratorState): Promise<IPluginManagerResponse>;
    canHandle(intent: string): boolean;
}

export interface IPendingAction {
    userId: string;
    intent: string;
    collectedParams: Map<string, string>;
    requiredParams: Set<string>;
    optionalParams: Set<string>;
    lastPromptedParam?: string;
    conversationContext: string[];
    attempts: number;
    maxAttempts: number;
}

export interface IIntentAnalysis {
    intent: string;
    confidence: number;
    extractedParams: Map<string, string>;
    suggestedResponse?: string;
    error?: string;
}

export interface IPluginDefinition {
    name: string;
    intents: string[];
    requiredParams: string[];
    optionalParams: string[];
    examples: string[];
}

export const ORCHESTRATOR_MESSAGE_TEMPLATE = `
You are an AI orchestrator managing user interactions for a blockchain bot.
Your role is to understand user intent and coordinate with specialized plugin managers.

Current conversation:
{{conversationContext}}

User message: {{message}}

Available plugins and their intents:
{{availablePlugins}}

Task: Analyze the message and determine:
1. User intent
2. Any explicitly provided parameters
3. Required follow-up questions

Return a JSON object with:
{
    "intent": "identified_intent",
    "confidence": 0.0-1.0,
    "extractedParams": {
        "param1": "value1",
        "param2": "value2"
    },
    "suggestedResponse": "response_to_user"
}

Note: Only return the JSON object, no other text.
`;

export const ORCHESTRATOR_RESPONSE_TEMPLATE = `
You are an AI assistant responding to a user's request about blockchain operations.
Your role is to provide clear, helpful responses while maintaining conversation context.

Current conversation:
{{conversationContext}}

User intent: {{intent}}
Collected parameters: {{collectedParams}}
Missing parameters: {{missingParams}}

Task: Generate a natural, helpful response that:
1. Acknowledges the user's request
2. Provides clear next steps or results
3. Maintains conversation context
4. Uses a friendly, professional tone

Return a JSON object with:
{
    "response": "your natural language response",
    "suggestedActions": ["possible", "next", "actions"],
    "confidence": 0.0-1.0,
    "requiresFollowUp": boolean
}
`;

export const PLUGIN_MANAGER_RESPONSE_TEMPLATE = `
You are a specialized plugin manager for {{pluginName}}.
Your role is to analyze user input and extract/validate parameters for your specific action.

Current conversation:
{{conversationContext}}

Required parameters: {{requiredParams}}
Optional parameters: {{optionalParams}}
Already collected: {{collectedParams}}
Current focus parameter: {{currentParameter}}

User message: {{message}}

Task: Analyze the message and:
1. Extract any relevant parameters
2. Validate parameter values
3. Determine if more information is needed
4. Suggest next parameter to collect

Return a JSON object with:
{
    "extractedParams": {
        "paramName": "value"
    },
    "validationResults": {
        "paramName": boolean
    },
    "nextParameter": "parameter to collect next",
    "confidence": 0.0-1.0,
    "suggestedPrompt": "how to ask for next parameter",
    "readyToExecute": boolean
}
`;

export interface IPluginManagerTemplate {
    pluginName: string;
    requiredParams: string[];
    optionalParams: string[];
    collectedParams: Map<string, string>;
    currentParameter?: string;
    message: string;
    conversationContext: string[];
}

export interface IOrchestratorTemplate {
    intent: string;
    collectedParams: Map<string, string>;
    missingParams: string[];
    conversationContext: string[];
    userMessage: string;
} 