import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer } from "effect"
import { app } from "electron"
import { join } from "node:path"
import { AppState } from "./services/AppState"
import { Bridge } from "./services/Bridge"
import { Controller } from "./services/Controller"
import { Pipeline } from "./services/Pipeline"
import { AppPaths, Settings } from "./services/Settings"
import { Tools } from "./services/Tools"
import { Worker } from "./services/Worker"
import { WindowLayer } from "./window"
import { ModelSetup } from "./services/ModelSetup"

// One instance only: a second one could not bind the bridge port anyway.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    const MainLayer = WindowLayer.pipe(
      Layer.provide(Controller.layer),
      Layer.provideMerge(ModelSetup.layer),
      Layer.provideMerge(Layer.mergeAll(Bridge.layer, Worker.layer)),
      Layer.provideMerge(Pipeline.layer),
      Layer.provideMerge(Layer.mergeAll(Settings.layer, Tools.layer, AppState.layer)),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(AppPaths, { userData: app.getPath("userData"),
        modelScripts: app.isPackaged ? join(process.resourcesPath, "models") : join(__dirname, "../../../../models") }))
    )

    const main = Effect.runFork(
      Layer.launch(MainLayer).pipe(
        Effect.tapCause((cause) => Effect.logError("floatfall crashed", cause))
      )
    )

    // Interrupting the root fiber closes every scope: child processes are
    // killed, the bridge socket is closed and the window is destroyed.
    let disposing = false
    app.on("before-quit", (event) => {
      if (disposing) return
      disposing = true
      event.preventDefault()
      void Effect.runPromise(Fiber.interrupt(main)).finally(() => app.exit(0))
    })
  })
}

app.on("window-all-closed", () => app.quit())
