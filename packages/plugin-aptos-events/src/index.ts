import { Plugin, IAgentRuntime, Provider } from "@elizaos/core";
import { Network } from "@aptos-labs/ts-sdk";
import { EventStreamListener } from "./services/event-stream-listener";
import { entryPointAction } from "./actions/entry-point";

class AptosEventsPlugin implements Plugin {
    readonly name = "aptos-events";
    readonly description = "Plugin for listening to Aptos blockchain events and triggering actions";
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    getProviders(): Provider[] {
        const network = this.runtime.getSetting("APTOS_NETWORK") as Network;
        const fullnode = this.runtime.getSetting("APTOS_FULLNODE");
        const botPortalAddress = this.runtime.getSetting("BOT_PORTAL_ADDRESS");

        if (!network || !fullnode || !botPortalAddress) {
            throw new Error("Missing required settings for Aptos event stream");
        }

        return [
            new EventStreamListener(
                this.runtime,
                botPortalAddress,
                network,
                fullnode
            )
        ];
    }

    getActions() {
        return [entryPointAction];
    }
}

export default AptosEventsPlugin; 