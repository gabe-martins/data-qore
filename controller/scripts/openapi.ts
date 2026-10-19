import { writeFileSync } from "node:fs";
import { openapi } from "../src/openapi.js";
writeFileSync(
  "../docs/openapi-controller.json",
  JSON.stringify(openapi(), null, 2) + "\n",
);
