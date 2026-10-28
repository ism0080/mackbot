import { Runtime } from "foldkit";

import "./styles.css";
import { Message, Model, init, subscriptions, update, view } from "./main.ts";

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    subscriptions,
    container: document.getElementById("root"),
    routing: {
      // The app has no external links of its own; an internal one is a screen.
      onUrlRequest: (request) =>
        request._tag === "Internal"
          ? Message.UrlRequested({ pathname: request.url.pathname })
          : Message.ExternalUrlRequested({ href: request.href }),
      onUrlChange: (url) => Message.UrlChanged({ pathname: url.pathname }),
    },
  }),
);
