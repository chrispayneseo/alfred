import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// Alfred Core does not execute generated code in its bootstrap release. A
// virtual filesystem is sufficient and avoids shipping a local VM runtime.
export const environment = JustBashSandbox.environment({ autoInstall: false });

export default defineSandbox(() => environment.open());
