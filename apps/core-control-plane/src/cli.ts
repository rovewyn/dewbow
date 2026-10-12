import { ControlPlane, readControlPlaneConfig } from "./index.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: core-control-plane [--check|--help]\nSee docs/control-plane.md for configuration and credentials. --check validates listener configuration without opening storage or a listener.");
} else if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("Usage: core-control-plane [--check|--help]"); process.exitCode = 1;
} else {
  try {
    const service = new ControlPlane(readControlPlaneConfig());
    if (args[0] === "--check") console.log(JSON.stringify({ component: "core-control-plane", configuration: "valid", runtime: "not_checked" }));
    else {
      await service.start();
      console.log(JSON.stringify({ component: "core-control-plane", status: "listening" }));
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void service.stop(); });
    }
  } catch (error) { console.error(error instanceof TypeError ? error.message : "Control Plane startup failed. Check listener, storage, and permitted-host configuration."); process.exitCode = 1; }
}
