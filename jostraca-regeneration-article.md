# Generating twice: what Jostraca does with files you have edited

I used the Voxgig SDK generator to produce a TypeScript SDK from the PostHog OpenAPI spec. The first run was the easy part. The next question was what happens on the second run, after a developer has changed one of the generated files.

Jostraca is a file generation library that takes that question seriously. It writes files from data and saves the previous output in a `.jostraca` folder, so a later run has a base to compare against. The difficulty is simple to state: once someone edits a generated file, the generator sees a difference between disk and its new output, and nothing tells it whether that difference is stale generated text or a colleague's work. I ran 32 tests across three files, on Windows with Node 22, to see how it decides.

## Where it worked

Rerunning with identical input produced no change and no conflict. Calling a component outside `generate()` threw a clear error. Both were better than I had assumed. With `.jostraca` intact, my manual edit survived regeneration through merge.

`Inject`, which rewrites only the region between two markers in an existing file, behaved well in most of its tests. The surrounding text stayed untouched, the markers survived so a second injection found them, multi-line regions were replaced whole, and a missing target file produced an explicit error suggesting `File`.

## Where it got uncomfortable

The default `write` mode removed a line I had added by hand, with no error. The tutorial documents this, and I read it as a trade-off rather than a bug. In one-shot generation, overwriting is often less surprising because the generator is normally considered the owner of the output. Under regeneration the same default means discarding whatever people did, so preservation becomes something you opt into. `Inject` applies the policy to a smaller area: an edit I made inside an injected region was deleted and reported as `written`, the same label as an ordinary write. The generator owns that region, so I find this coherent. The result list still looks the same for a clean write and for one that threw away an edit.

JSON was where the file itself broke. In my JSON merge-conflict test, the conflict was recorded in `conflicted`, yet the file on disk contained `>>>>>>>` markers and no longer parsed. In another test, a value containing a quote and a newline produced invalid JSON, and I found no escaping helper apart from `escre`, which is for regexes. Changing the file to CRLF under my Windows Git setup marked the file as one large conflict, even though the content itself had not changed. In my test, the comparison behaved as a text-level comparison. That suits a shell script. It is riskier for a file that must stay parseable, and `Inject` does not close the gap, since its default markers such as `#--START--#` are `#` comments and JSON has none. I did not verify whether Jostraca provides format-specific options for non-text formats, so I would not treat this as a definitive limitation.

Deleting `.jostraca` removes the baseline. On the next run my edited file was reported as `written`, indistinguishable from an ordinary write, and the folder was recreated. The edit was gone. If that folder isn't versioned with the project, a clean clone or a CI runner could start in the same position. I did not test that; I only deleted the folder. A guard along these lines would sit in front of regeneration:

```js
const hasFiles = existsSync(out) && readdirSync(out).some(n => n !== '.jostraca')
if (hasFiles && !existsSync(join(out, '.jostraca')))
  throw new Error('.jostraca missing, refusing to regenerate')
```

Protection raises the visibility question directly. A file protected with `JOSTRACA_PROTECT` stayed intact, so the mechanism works. It also appeared in none of the result lists. When `Inject` cannot find its markers it injects nothing and lists the file as `unchanged`; a warning reaches the terminal but not the code that called `generate()`. Removing an element from the model left its old file in place, with no report. Jostraca does return `written`, `merged`, `conflicted` and `unchanged` lists, so enforcement is up to the caller:

```js
const { files } = await jostraca.generate(opts, tree)
if (files.conflicted.length) throw new Error('merge conflicts: ' + files.conflicted)
if (files.unchanged.length) console.warn('check unchanged: CRLF or missing markers?')
```

## When I would use it

I would be comfortable with Jostraca when regeneration is a requirement and the output is text that allows comments, such as shell scripts or YAML. There `Inject` gives the generator a region and leaves the rest to the people editing the file. I would pin LF line endings with `* text eol=lf` in `.gitattributes` and wrap `generate()` in checks like the two above.

I would be more cautious with JSON and other formats that must stay parseable, with Windows teams whose git settings rewrite line endings, and with workflows where a skipped or discarded edit would cost more than a failed build.

These results come from one Windows machine on Node 22. I did not test the Go version, `Copy`, `CopyFiles`, `List`, other operating systems or a large project. Two further results, nested `async` calls dropping output without a signal and a `$$` pair writing the full model into a file, fall outside the regeneration question, and I could not confirm why either happens.
