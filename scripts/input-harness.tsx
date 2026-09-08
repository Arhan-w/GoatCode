/** Minimal ink input harness: logs every raw stdin byte + parsed key to a file. */
import { render, useInput, Text } from "ink";
import { appendFileSync } from "node:fs";

function H() {
  useInput((input, key) => {
    appendFileSync("D:/GoatCode-ts/scripts/input-log.txt",
      `input=${JSON.stringify(input)} return=${key.return} escape=${key.escape} ctrl=${key.ctrl}\n`);
  });
  return <Text>listening</Text>;
}
render(<H />, { stdin: process.stdin, stdout: process.stdout, exitOnCtrlC: false });
process.stdin.on("data", (b) => {
  appendFileSync("D:/GoatCode-ts/scripts/input-log.txt", `raw=${JSON.stringify(b.toString())}\n`);
});
