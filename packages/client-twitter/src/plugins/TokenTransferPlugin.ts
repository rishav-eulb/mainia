import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger
} from "@elizaos/core";
import { ClientBase } from "../base";
import { KeywordActionPlugin, type IKeywordAction, type IParameterRequirement } from "./KeywordActionPlugin";

export interface TokenTransferParams {
    amount: string;
    recipient: string;
    tokenType?: string;
}

export class TokenTransferPlugin {
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.registerActions();
        elizaLogger.info("TokenTransferPlugin: Initialized");
    }

    // Add method to get registered actions
    public getRegisteredActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    // This method will be called by the contract/service to execute the actual transfer
    private async stage_execute(params: TokenTransferParams): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
    }> {
        try {
            elizaLogger.info("TokenTransferPlugin: Executing transfer:", params);
            
            // Simulate a blockchain transaction
            const mockTxId = `tx_${Date.now()}_${Math.random().toString(36).substring(7)}`;
            
            return {
                success: true,
                transactionId: mockTxId
            };
        } catch (error) {
            elizaLogger.error("TokenTransferPlugin: Error executing transfer:", error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    private registerActions() {
        const transferAction: IKeywordAction = {
            name: "transfer_tokens",
            description: "Transfer tokens to another user",
            examples: [
                "send 100 USDC to @user",
                "transfer 50 ETH to @recipient",
                "send 25 USDC to @alice",
                "@radhemfeulb69 send 100 USDC to @user",
                "@radhemfeulb69 transfer 50 ETH to @user",
                "send 100 USDC to\n@user",  // Handle newline cases
                "transfer 100 to @user",
                "send 50 to @user"
            ],
            requiredParameters: [
                {
                    name: "amount",
                    prompt: "How many tokens would you like to transfer?",
                    validator: (value: string) => !isNaN(Number(value)) && Number(value) > 0,
                    extractorTemplate: `
# Task: Extract the numeric amount from this transfer request
Message: {{userMessage}}

Rules:
1. Look for a number followed by a token type or just a number
2. Return only the numeric value
3. If multiple numbers exist, take the one that appears to be the transfer amount
4. Handle decimal numbers if present

Return the amount as a string, or null if no valid amount found.`
                },
                {
                    name: "recipient",
                    prompt: "Who would you like to send the tokens to? Please provide their @username",
                    validator: (value: string) => value.startsWith("@"),
                    extractorTemplate: `
# Task: Extract the recipient's username from this transfer request
Message: {{userMessage}}

Rules:
1. Look for a Twitter username starting with @
2. Handle cases where the username might be on a new line
3. If multiple usernames exist, take the one that appears to be the recipient
4. Ignore the bot's own username if it's mentioned

Return the username with @ prefix, or null if no valid username found.`
                },
                {
                    name: "tokenType",
                    prompt: "What type of token would you like to transfer? (e.g., ETH, USDC)",
                    validator: (value: string) => value.length > 0,
                    extractorTemplate: `
# Task: Extract the token type from this transfer request
Message: {{userMessage}}

Rules:
1. Look for common token types like ETH, USDC, USDT, etc.
2. The token type usually appears after the amount or is mentioned explicitly
3. Default to USDC if no specific token type is mentioned but the context clearly indicates a token transfer
4. Handle both uppercase and lowercase token symbols
5. If only ETH is mentioned without an amount, it's likely just mentioning the token type
6. Consider the entire conversation context for token type

Previous conversation context:
{{conversationContext}}

Return a JSON object in this format:
{
    "extracted": true/false,
    "value": "TOKEN_TYPE or null if not found",
    "confidence": "HIGH/MEDIUM/LOW",
    "alternativeValues": ["other", "possible", "tokens"],
    "clarificationNeeded": true/false,
    "suggestedPrompt": "What type of token would you like to transfer? (e.g., ETH, USDC)",
    "reasoning": "Brief explanation of why this token type was chosen"
}

Only respond with the JSON, no other text.`
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                elizaLogger.info("TokenTransferPlugin: Processing transfer action with params:", Object.fromEntries(params));
                
                // Validate all required parameters are present
                const amount = params.get("amount");
                const recipient = params.get("recipient");
                const tokenType = params.get("tokenType") || "USDC";

                if (!amount || !recipient) {
                    return {
                        response: "I couldn't process your transfer request. Please make sure to specify both the amount and recipient.",
                        action: "ERROR"
                    };
                }

                const transferParams: TokenTransferParams = {
                    amount,
                    recipient,
                    tokenType
                };

                const result = await this.stage_execute(transferParams);

                if (result.success) {
                    return {
                        response: `Successfully initiated transfer of ${transferParams.amount} ${transferParams.tokenType} to ${transferParams.recipient}. Transaction ID: ${result.transactionId}`,
                        data: { transactionId: result.transactionId },
                        action: "EXECUTE_ACTION"
                    };
                } else {
                    return {
                        response: `Failed to execute transfer: ${result.error}`,
                        action: "ERROR"
                    };
                }
            }
        };

        // Store the action in our registeredActions array
        this.registeredActions.push(transferAction);
        elizaLogger.info("TokenTransferPlugin: Registered transfer action with examples:", transferAction.examples);
    }
} 