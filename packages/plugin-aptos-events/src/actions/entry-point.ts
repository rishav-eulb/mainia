import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory } from "@elizaos/core";

interface EventData {
    tweet?: string;
    action?: string;
    [key: string]: any;
}

// Map of supported actions and their validation rules
const SUPPORTED_ACTIONS = new Map([
    ['REPLY_TWEET', {
        requiredFields: ['tweet', 'replyToTweetId'],
        validate: (data: any) => {
            if (!data.replyToTweetId) {
                return "Missing replyToTweetId for REPLY_TWEET action";
            }
            return null; // null means validation passed
        }
    }],
    ['CREATE_TWEET', {
        requiredFields: ['tweet'],
        validate: (data: any) => null // Only basic tweet validation needed
    }]
    // Add more actions and their validation rules here
]);

export const entryPointAction: Action = {
    name: "ENTRY_POINT",
    description: "Handle entry point actions for Aptos events",
    examples: [],
    similes: ["HANDLE_ENTRY", "PROCESS_ENTRY"],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
    handler: async (runtime: IAgentRuntime, request: Memory) => {
        const eventData = request.content as EventData;

        // Basic validation for tweet data
        if (!eventData.tweet || typeof eventData.tweet !== 'string') {
            elizaLogger.warn('Invalid or missing tweet data in event:', eventData);
            return {
                text: "Event rejected: Missing or invalid tweet data",
                error: true
            };
        }

        // Validate action name
        if (!eventData.action || typeof eventData.action !== 'string') {
            elizaLogger.warn('Invalid or missing action in event:', eventData);
            return {
                text: "Event rejected: Missing or invalid action name",
                error: true
            };
        }

        // Check if action is supported
        const actionConfig = SUPPORTED_ACTIONS.get(eventData.action);
        if (!actionConfig) {
            elizaLogger.warn(`Unsupported action: ${eventData.action}`);
            return {
                text: `Event rejected: Unsupported action ${eventData.action}`,
                error: true
            };
        }

        // Perform action-specific validation
        const validationError = actionConfig.validate(eventData);
        if (validationError) {
            elizaLogger.warn(`Validation failed for ${eventData.action}:`, validationError);
            return {
                text: `Event rejected: ${validationError}`,
                error: true
            };
        }

        try {
            // Forward to the specified action
            const result = await runtime.processActions(
                {
                    userId: request.userId,
                    agentId: request.agentId,
                    roomId: request.roomId,
                    content: {
                        text: eventData.tweet,
                        action: eventData.action,
                        // Pass through any additional event data
                        ...eventData
                    }
                },
                []
            );

            return {
                text: `Successfully processed ${eventData.action} action`,
                data: result
            };

        } catch (error) {
            elizaLogger.error('Error processing action:', {
                error: error instanceof Error ? error.message : String(error),
                action: eventData.action,
                data: eventData
            });

            return {
                text: `Failed to process ${eventData.action} action: ${error instanceof Error ? error.message : String(error)}`,
                error: true
            };
        }
    }
}; 