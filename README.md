# pi-thunder-jev

`jev_find` for [Pi](https://pi.dev): ask "where is the code for X?" in words, and get the files that matter, ranked, with the best excerpts and their line numbers. It takes about a second.

[Jev](https://typesafe.ai) (TypeSafe's System One) does the reading. It decides; it does not write. Its answers are probabilities, so the thresholds stay in code here. This is the search the workers in [Thunder Foundry](https://github.com/Mandalorian007/thunder-foundry) run.

There, the plan stage of its Software Factory was told to start with `jev_find`. It read 108K fewer characters and cost 22% less per task, with no loss in tasks resolved. On a private repository, the tool cut model calls by 16–44% and wall time by 14–40%, at about the same total cost.

## Install

```sh
pi install git:github.com/Mandalorian007/pi-thunder-jev        # every pi process for this user
pi install git:github.com/Mandalorian007/pi-thunder-jev -l     # this project only
pi -e git:github.com/Mandalorian007/pi-thunder-jev             # try it for one run
```

Pin a version with `@v0.1.0`.

It needs a TypeSafe key, which you can give it in either of two ways:
- In Pi's credentials, `~/.pi/agent/auth.json`:
  ```json
  { "typesafe": { "type": "api_key", "key": "…" } }
  ```
  `key` can also be a command, such as `"!security find-generic-password -ws typesafe"`.
- As `TYPESAFE_API_KEY` in the environment.

`pi auth check --provider typesafe` tells you whether the key is ready.

## How it searches

1. **Files.** Every tracked text file gets a skeleton of up to 600 characters: its path, its leading comment and its declaration lines. Lockfiles, minified files, binaries and files over 600KB are skipped. Tests, fixtures and docs are left out too, unless the agent passes `paths`. Jev judges the skeletons many to a call, one yes/no question per file.
2. **Chunks.** The best eight files are cut into chunks of at most 40 lines, and Jev judges each chunk.
3. **Answer.** Files rank by their best chunk. The answer lists:
   - the strong line ranges in each file;
   - the next-best score;
   - the three best excerpts.

When the best score is under 0.65, it says nothing relevant was found, and lists the weak candidates. That is evidence of absence the agent can act on. The threshold separated present answers from absent ones on 65 benchmark questions.

Jev costs $0.042 per million input tokens, which comes to about $0.01 a search on an 800-file repository.

## Files

- `find.ts`: the search, with no imports.
- `index.ts`: lists the files, calls Jev (retrying 429s and 5xx, at most 16 calls in flight) and registers the tool.

`npm test` runs the search offline against a scripted Jev.
