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
}

// Interface for defining an action that can be triggered by keywords

// can we use IKeywordPlugin instead of IKeywordAction?
export interface IKeywordAction {
    name: string;           
    description: string;    
    examples: string[];     
    requiredParameters?: IParameterRequirement[];
    metadata?: {
        category: 'QUERY' | 'MUTATION' | 'CONDITION' | 'COMPOSITE';  // Type of action
        returns?: {
            type: 'NUMBER' | 'BOOLEAN' | 'STRING' | 'ADDRESS' | 'OBJECT';  // Return type for chaining
            unit?: string;  // e.g., 'MOVE', 'USD', etc.
            constraints?: {
                min?: number;
                max?: number;
                pattern?: string;
            };
        };
        dependencies?: string[];  // Actions that must be executed before this one
        canBeCondition?: boolean;  // Can this action be used in conditional statements
        composable?: boolean;  // Can this action be part of a composite operation
        sideEffects?: boolean;  // Does this action modify state
        cost?: 'HIGH' | 'MEDIUM' | 'LOW';  // Resource/computational cost
        timeout?: number;  // Maximum execution time in ms
    };
    action: (tweet: Tweet, runtime: IAgentRuntime, collectedParams?: Map<string, string>) => Promise<{
        response: string;
        data?: any;
        action?: string;
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

// Define a type for action expressions that can be evaluated
interface ActionExpression {
    type: 'ACTION' | 'CONDITION' | 'OPERATOR' | 'VALUE';
    value: string | number | ActionExpression[];
    operator?: 'AND' | 'OR' | 'GT' | 'LT' | 'EQ' | 'ADD' | 'SUB' | 'MUL' | 'DIV';
    children?: ActionExpression[];
    parameters?: Map<string, string>;
    priority?: number;
}

// Define a type for the execution context
interface ExecutionContext {
    variables: Map<string, any>;
    results: Map<string, any>;
    errors: Error[];
    depth: number;
    maxDepth: number;
}

export class KeywordActionPlugin {
    private plugins: Map<string, IKeywordPlugin> = new Map();
    private actions: IKeywordAction[] = [];
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private pendingActions: Map<string, PendingAction> = new Map();
    private TIMEOUT_MS = 5 * 60 * 1000;
    private MAX_ATTEMPTS = 3;
    private MAX_CLARIFICATIONS = 2;

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
            content: { text: tweet.text || "" },
            embedding: getEmbeddingZeroVector(),
            createdAt: Date.now()
        };

        const state = await this.runtime.composeState(memory, {
            availableActions,
            conversationContext: conversationContext.join("\n"),
            tweet: tweet.text
        });

        const context = composeContext({
            state,
            template: `# Task: Analyze user request for potential actions and conditions

Available Actions:
{{availableActions}}

User's message:
{{tweet}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Break down complex requests into individual actions
2. Identify conditional relationships between actions
3. Look for:
   - Balance checks
   - Token transfers
   - Wallet queries
   - Conditions (if/then statements)
   - Numerical comparisons
4. Consider variations in phrasing and implicit actions
5. Return analysis in this JSON format:
{
    "actions": [
        {
            "type": "ACTION",
            "name": string,
            "priority": number,
            "parameters": object,
            "dependsOn": string[] // IDs of actions this depends on
        }
    ],
    "conditions": [
        {
            "type": "CONDITION",
            "check": {
                "action": string,
                "comparison": "GT" | "LT" | "EQ",
                "value": number
            },
            "thenActions": string[],
            "elseActions": string[]
        }
    ],
    "reasoning": string
}

Only respond with the JSON, no other text.`
        });

        const intentAnalysis = await generateText({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL
        });

        try {
            const analysis = JSON.parse(intentAnalysis);
            const matchedActions = [];
            
            // Process actions based on conditions
            if (analysis.actions && analysis.conditions) {
                // First, add all unconditional actions
                const unconditionalActions = analysis.actions.filter(
                    a => !analysis.conditions.some(c => 
                        c.thenActions.includes(a.name) || 
                        c.elseActions.includes(a.name)
                    )
                );
                
                for (const actionInfo of unconditionalActions) {
                    const action = this.actions.find(a => a.name === actionInfo.name);
                    if (action) {
                        matchedActions.push({
                            action,
                            parameters: actionInfo.parameters,
                            priority: actionInfo.priority || 0
                        });
                    }
                }

                // Then process conditional actions
                for (const condition of analysis.conditions) {
                    const checkAction = this.actions.find(a => a.name === condition.check.action);
                    if (checkAction) {
                        matchedActions.push({
                            action: checkAction,
                            parameters: {},
                            priority: 1, // Check conditions first
                            isCondition: true,
                            condition
                        });
                    }
                }
            } else {
                // Fallback to simple action matching
                for (const action of this.actions) {
                    const matches = action.examples.some(example => 
                        tweet.text.toLowerCase().includes(example.toLowerCase()) ||
                        example.toLowerCase().includes(tweet.text.toLowerCase())
                    );
                    if (matches) {
                        matchedActions.push({
                            action,
                            parameters: {},
                            priority: 0
                        });
                    }
                }
            }

            // Sort actions by priority
            return matchedActions.sort((a, b) => b.priority - a.priority);
        } catch (error) {
            elizaLogger.error("Error parsing intent analysis:", error);
            // Fallback to simple action matching
            return this.actions.filter(action => 
                action.examples.some(example => 
                    tweet.text.toLowerCase().includes(example.toLowerCase()) ||
                    example.toLowerCase().includes(tweet.text.toLowerCase())
                )
            );
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
        results?: Array<{
            action: string;
            response: string;
            data?: any;
        }>;
    }> {
        try {
            // First, analyze the tweet to build action expressions
            const state = await this.runtime.composeState({
                id: stringToUuid(tweet.id + "-intent"),
                userId: stringToUuid(tweet.userId),
                agentId: this.runtime.agentId,
                roomId: stringToUuid(tweet.id),
                content: { text: tweet.text || "" },
                embedding: getEmbeddingZeroVector(),
                createdAt: Date.now()
            }, {
                availableActions: this.actions.map(a => ({
                    name: a.name,
                    description: a.description,
                    metadata: a.metadata,
                    examples: a.examples
                })),
                tweet: tweet.text
            });

            const context = composeContext({
                state,
                template: `# Task: Parse user request into action expressions

Available Actions with Metadata:
{{availableActions}}

User's message:
{{tweet}}

# Instructions:
1. Break down the request into a series of action expressions
2. Consider:
   - Direct actions
   - Conditional statements
   - Mathematical operations
   - Logical operations
3. Return the expressions as a JSON array:
[
    {
        "type": "ACTION" | "CONDITION" | "OPERATOR" | "VALUE",
        "value": string | number,
        "operator"?: "AND" | "OR" | "GT" | "LT" | "EQ" | "ADD" | "SUB" | "MUL" | "DIV",
        "children"?: Array<Expression>,
        "parameters"?: object,
        "priority"?: number
    }
]

Only respond with the JSON array, no other text.`
            });

            const expressionsResponse = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            let expressions: ActionExpression[];
            try {
                expressions = JSON.parse(expressionsResponse);
            } catch (error) {
                elizaLogger.error("Error parsing expressions:", error);
                return {
                    hasAction: false,
                    response: "I'm having trouble understanding your request. Could you please rephrase it?"
                };
            }

            if (!expressions || expressions.length === 0) {
                return {
                    hasAction: false,
                    response: "I understand you're trying to perform some actions. I can help with:\n" +
                        this.actions.map(a => `- ${a.description}`).join("\n") +
                        "\nPlease let me know what you'd like to do."
                };
            }

            // Execute the action graph
            const results = await this.executeActionGraph(expressions, tweet);
            
            if (results.size === 0) {
                return {
                    hasAction: false,
                    response: "I couldn't execute any actions. Please check if you have the necessary permissions and try again."
                };
            }

            // Format the response based on results
            const responses: string[] = [];
            for (const [actionName, result] of results.entries()) {
                const action = this.getActionByName(actionName);
                if (action?.metadata?.category === 'QUERY') {
                    responses.push(`${action.description}: ${result}`);
                } else if (action?.metadata?.category === 'MUTATION') {
                    responses.push(`Successfully ${action.description.toLowerCase()}`);
                }
            }

            return {
                hasAction: true,
                action: "COMPOSITE",
                response: responses.join("\n"),
                results: Array.from(results.entries()).map(([action, data]) => ({
                    action,
                    response: `Completed ${action}`,
                    data
                }))
            };

        } catch (error) {
            elizaLogger.error("Error in processTweet:", error);
            return {
                hasAction: true,
                action: "ERROR",
                response: "I encountered an error while processing your request. Please try again with a simpler request."
            };
        }
    }

    private async evaluateExpression(
        expression: ActionExpression, 
        context: ExecutionContext,
        tweet: Tweet
    ): Promise<any> {
        if (context.depth > context.maxDepth) {
            throw new Error('Maximum expression depth exceeded');
        }

        switch (expression.type) {
            case 'VALUE':
                return expression.value;

            case 'ACTION': {
                const actionName = expression.value as string;
                const action = this.getActionByName(actionName);
                
                if (!action) {
                    throw new Error(`Unknown action: ${actionName}`);
                }

                // Check if we have the result cached
                if (context.results.has(actionName)) {
                    return context.results.get(actionName);
                }

                // Execute the action
                const result = await action.action(
                    tweet, 
                    this.runtime, 
                    expression.parameters || new Map()
                );
                
                // Cache the result
                context.results.set(actionName, result.data);
                return result.data;
            }

            case 'CONDITION': {
                const [left, operator, right] = expression.children || [];
                const leftValue = await this.evaluateExpression(left, {
                    ...context,
                    depth: context.depth + 1
                }, tweet);
                const rightValue = await this.evaluateExpression(right, {
                    ...context,
                    depth: context.depth + 1
                }, tweet);

                switch (operator.value) {
                    case 'GT': return leftValue > rightValue;
                    case 'LT': return leftValue < rightValue;
                    case 'EQ': return leftValue === rightValue;
                    default: throw new Error(`Unknown operator: ${operator.value}`);
                }
            }

            case 'OPERATOR': {
                const results = await Promise.all(
                    (expression.children || []).map(child =>
                        this.evaluateExpression(child, {
                            ...context,
                            depth: context.depth + 1
                        }, tweet)
                    )
                );

                switch (expression.operator) {
                    case 'AND': return results.every(Boolean);
                    case 'OR': return results.some(Boolean);
                    case 'ADD': return results.reduce((a, b) => a + b, 0);
                    case 'SUB': return results.reduce((a, b) => a - b);
                    case 'MUL': return results.reduce((a, b) => a * b, 1);
                    case 'DIV': return results.reduce((a, b) => a / b);
                    default: throw new Error(`Unknown operator: ${expression.operator}`);
                }
            }

            default:
                throw new Error(`Unknown expression type: ${expression.type}`);
        }
    }

    private buildActionGraph(actions: IKeywordAction[]): Map<string, Set<string>> {
        const graph = new Map<string, Set<string>>();
        
        for (const action of actions) {
            if (!graph.has(action.name)) {
                graph.set(action.name, new Set());
            }
            
            if (action.metadata?.dependencies) {
                for (const dep of action.metadata.dependencies) {
                    if (!graph.has(dep)) {
                        graph.set(dep, new Set());
                    }
                    graph.get(dep)?.add(action.name);
                }
            }
        }
        
        return graph;
    }

    private async executeActionGraph(
        expressions: ActionExpression[],
        tweet: Tweet
    ): Promise<Map<string, any>> {
        const context: ExecutionContext = {
            variables: new Map(),
            results: new Map(),
            errors: [],
            depth: 0,
            maxDepth: 10
        };

        // Build dependency graph
        const graph = this.buildActionGraph(this.actions);
        const executed = new Set<string>();
        const results = new Map<string, any>();

        // Topologically sort and execute actions
        const executionOrder = this.topologicalSort(graph);
        
        for (const actionName of executionOrder) {
            if (executed.has(actionName)) continue;
            
            const action = this.getActionByName(actionName);
            if (!action) continue;

            try {
                // Find relevant expressions for this action
                const actionExpressions = expressions.filter(expr => 
                    expr.type === 'ACTION' && expr.value === actionName
                );

                for (const expr of actionExpressions) {
                    const result = await this.evaluateExpression(expr, context, tweet);
                    results.set(actionName, result);
                    executed.add(actionName);
                }
            } catch (error) {
                context.errors.push(error);
                elizaLogger.error(`Error executing action ${actionName}:`, error);
            }
        }

        return results;
    }

    private topologicalSort(graph: Map<string, Set<string>>): string[] {
        const visited = new Set<string>();
        const temp = new Set<string>();
        const order: string[] = [];

        function visit(node: string) {
            if (temp.has(node)) {
                throw new Error('Cyclic dependency detected');
            }
            if (visited.has(node)) return;

            temp.add(node);
            const deps = graph.get(node) || new Set();
            for (const dep of deps) {
                visit(dep);
            }
            temp.delete(node);
            visited.add(node);
            order.unshift(node);
        }

        for (const node of graph.keys()) {
            if (!visited.has(node)) {
                visit(node);
            }
        }

        return order;
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