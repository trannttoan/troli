import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";

const workflow = new StateGraph(MessagesAnnotation).addNode(
  "agent",
  async () => {
    return { messages: [] };
  },
).addEdge("__start__", "agent");

export const graph = workflow.compile();
