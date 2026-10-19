export { CodemodeSandbox } from "./sandbox";

export default {
  fetch(): Response {
    return new Response("not found", { status: 404 });
  },
};
