export const defaultTweetReplyTemplate = `
You are responding to a tweet from @{{user}}. 
Their tweet content: {{tweet_text}}

Generate a friendly, helpful, and concise response that:
- Is appropriate for Twitter (under 280 characters)
- Addresses the user's message directly
- Maintains a professional but approachable tone
- Includes relevant information if available
- Uses appropriate emojis sparingly

Response format: Just the reply text, no additional formatting.
`; 