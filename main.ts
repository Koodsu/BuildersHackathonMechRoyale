import { run } from "./mechfight.ts"
import { Brain } from "./src/bot.ts"

run((hello) => new Brain(hello))
