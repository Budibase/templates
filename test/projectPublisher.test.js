const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { Readable } = require("node:stream")
const test = require("node:test")
const { GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3")
const { publishProjectCatalogue } = require("../src/projectPublisher")

const bucket = "example-project-templates"
const region = "eu-west-1"
const repositoryUrl = "https://example.com"
const currentKey = "catalogue/project/v1/current.json"
const oldPointer = Buffer.from("previous release")

const createPublication = async ({ t }) => {
  const directory = await mkdtemp(join(tmpdir(), "project-publisher-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const descriptor = async ({ key, body, contentType, pointer = false }) => {
    const path = join(
      directory,
      `${pointer ? "pointer" : key.split("/").pop()}`
    )
    await writeFile(path, body)
    return {
      key,
      path,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.length,
      contentType,
      cacheControl: pointer ? "no-cache" : "public,max-age=31536000,immutable",
    }
  }
  const archive = await descriptor({
    key: "artifacts/project/example-template/1.0.0/project.tar.gz",
    body: Buffer.from("native Project export archive"),
    contentType: "application/gzip",
  })
  const image = await descriptor({
    key: "artifacts/project/example-template/1.0.0/preview.png",
    body: Buffer.from("preview image"),
    contentType: "image/png",
  })
  const catalogue = await descriptor({
    key: "catalogue/project/v1/releases/release-1.json",
    body: Buffer.from('{"templates":[{"id":"example-template"}]}'),
    contentType: "application/json",
  })
  const pointer = await descriptor({
    key: currentKey,
    body: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        catalogueVersion: "release-1",
        sha256: catalogue.sha256,
      })
    ),
    contentType: "application/json",
    pointer: true,
  })
  return {
    repositoryUrl,
    catalogueVersion: "release-1",
    publishedAt: "2026-11-09T12:00:00.000Z",
    templates: [{ id: "example-template" }],
    objects: [archive, image, catalogue],
    pointer,
  }
}

const createClient = ({ onSend } = {}) => {
  const objects = new Map([[currentKey, oldPointer]])
  const commands = []
  const client = {
    async send(command) {
      commands.push(command)
      await onSend?.({ command, objects })
      const { Key, Body } = command.input
      if (command instanceof GetObjectCommand) {
        if (!objects.has(Key)) {
          throw Object.assign(new Error("Missing object"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          })
        }
        return { Body: Readable.from([objects.get(Key)]) }
      }
      assert.ok(command instanceof PutObjectCommand)
      if (command.input.IfNoneMatch === "*" && objects.has(Key)) {
        throw Object.assign(new Error("Object exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        })
      }
      objects.set(Key, Buffer.from(Body))
      return {}
    },
  }
  return { client, objects, commands }
}

const createPublicFetch = ({ publication }) => async (url) => {
  const object = publication.objects.find(
    ({ key }) => new URL(key, repositoryUrl).toString() === url.toString()
  )
  assert.ok(object)
  return new Response(await readFile(object.path))
}

const publish = ({
  publication,
  client,
  fetch = createPublicFetch({ publication }),
}) => publishProjectCatalogue({ publication, bucket, region, client, fetch })

test("uploads and verifies immutable objects before changing the pointer", async (t) => {
  const publication = await createPublication({ t })
  const publicReads = []
  const { client, objects, commands } = createClient({
    onSend: async ({ command }) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key === currentKey
      ) {
        assert.deepEqual(
          publicReads,
          publication.objects.map(({ key }) => key)
        )
      }
    },
  })
  const result = await publish({
    publication,
    client,
    fetch: async (url, options) => {
      const key = url.pathname.slice(1)
      assert.equal(url.origin, repositoryUrl)
      assert.equal(options.redirect, "error")
      assert.equal(options.credentials, "omit")
      assert.equal(options.headers["Accept-Encoding"], "identity")
      assert.ok(options.signal instanceof AbortSignal)
      publicReads.push(key)
      return new Response(objects.get(key))
    },
  })
  const writes = commands.filter(
    (command) => command instanceof PutObjectCommand
  )
  assert.deepEqual(result, {
    skipped: false,
    uploadedKeys: publication.objects.map((object) => object.key),
    reusedKeys: [],
    pointerKey: currentKey,
  })
  assert.deepEqual(
    writes.map((command) => command.input.Key),
    [...publication.objects.map((object) => object.key), currentKey]
  )
  assert.deepEqual(
    commands
      .slice(0, publication.objects.length)
      .map((command) => command.input.Key),
    publication.objects.map((object) => object.key)
  )
  for (const [index, object] of publication.objects.entries()) {
    const write = writes[index]
    assert.equal(write.input.Bucket, bucket)
    assert.equal(write.input.IfNoneMatch, "*")
    assert.equal(write.input.ContentType, object.contentType)
    assert.equal(write.input.CacheControl, "public,max-age=31536000,immutable")
    assert.equal(write.input.ContentEncoding, undefined)
    assert.equal(
      write.input.ChecksumSHA256,
      Buffer.from(object.sha256, "hex").toString("base64")
    )
    const verification = commands.findIndex(
      (command, commandIndex) =>
        commandIndex > commands.indexOf(write) &&
        command instanceof GetObjectCommand &&
        command.input.Key === object.key
    )
    assert.ok(verification > commands.indexOf(write))
    assert.ok(verification < commands.indexOf(writes.at(-1)))
  }
  assert.equal(writes.at(-1).input.IfNoneMatch, undefined)
  assert.equal(writes.at(-1).input.CacheControl, "no-cache")
  assert.equal(writes.at(-1).input.ContentType, "application/json")
  assert.notDeepEqual(objects.get(currentKey), oldPointer)
  assert.ok(
    commands.every(
      (command) =>
        command instanceof GetObjectCommand ||
        command instanceof PutObjectCommand
    )
  )
})

test("preserves the pointer when the public release returns 403", async (t) => {
  const publication = await createPublication({ t })
  const release = publication.objects.at(-1)
  const { client, objects, commands } = createClient()
  const publicFetch = createPublicFetch({ publication })
  await assert.rejects(
    publish({
      publication,
      client,
      fetch: async (url) =>
        url.pathname === `/${release.key}`
          ? new Response("Access denied", { status: 403 })
          : publicFetch(url),
    }),
    /Unable to verify public Project publication object.*HTTP 403/
  )
  assert.deepEqual(objects.get(currentKey), oldPointer)
  assert.equal(
    commands.some(
      (command) =>
        command instanceof PutObjectCommand && command.input.Key === currentKey
    ),
    false
  )
})

test("preserves the pointer when a public archive has the wrong checksum", async (t) => {
  const publication = await createPublication({ t })
  const archive = publication.objects[0]
  const { client, objects } = createClient()
  await assert.rejects(
    publish({
      publication,
      client,
      fetch: async () => new Response(Buffer.alloc(archive.sizeBytes)),
    }),
    /Public object does not match its declared size or checksum/
  )
  assert.deepEqual(objects.get(currentKey), oldPointer)
})

test("rechecks public access when immutable objects are reused", async (t) => {
  const publication = await createPublication({ t })
  const { client, objects, commands } = createClient()
  await publish({ publication, client })
  objects.set(currentKey, oldPointer)
  const writesBeforeRetry = commands.filter(
    (command) => command instanceof PutObjectCommand
  ).length
  await assert.rejects(
    publish({
      publication,
      client,
      fetch: async () => new Response("Access denied", { status: 403 }),
    }),
    /HTTP 403/
  )
  assert.deepEqual(objects.get(currentKey), oldPointer)
  assert.equal(
    commands.filter((command) => command instanceof PutObjectCommand).length,
    writesBeforeRetry
  )
})

test("stops reading an oversized public response before promoting the pointer", async (t) => {
  const publication = await createPublication({ t })
  const archive = publication.objects[0]
  const { client, objects } = createClient()
  let cancelled = false
  let reads = 0
  await assert.rejects(
    publish({
      publication,
      client,
      fetch: async () => ({
        ok: true,
        body: new ReadableStream(
          {
            pull(controller) {
              reads++
              controller.enqueue(Buffer.alloc(archive.sizeBytes + 1))
            },
            cancel() {
              cancelled = true
            },
          },
          { highWaterMark: 0 }
        ),
      }),
    }),
    /Public object exceeds its declared size/
  )
  assert.equal(reads, 1)
  assert.equal(cancelled, true)
  assert.deepEqual(objects.get(currentKey), oldPointer)
})

test("rejects an unsafe public origin before contacting S3", async (t) => {
  const publication = await createPublication({ t })
  publication.repositoryUrl = "http://example.com"
  const { client, commands } = createClient()
  await assert.rejects(
    publish({ publication, client }),
    /requires a public HTTPS repository origin/
  )
  assert.deepEqual(commands, [])
})

test("retries a partial publication without rewriting existing immutable objects", async (t) => {
  const publication = await createPublication({ t })
  const releaseKey = publication.objects.at(-1).key
  let failRelease = true
  const { client, objects, commands } = createClient({
    onSend: async ({ command }) => {
      if (
        failRelease &&
        command instanceof PutObjectCommand &&
        command.input.Key === releaseKey
      ) {
        throw new Error("Upload failed")
      }
    },
  })
  await assert.rejects(publish({ publication, client }), /Upload failed/)
  assert.deepEqual(objects.get(currentKey), oldPointer)
  failRelease = false
  const result = await publish({ publication, client })
  assert.deepEqual(result.uploadedKeys, [releaseKey])
  assert.deepEqual(
    result.reusedKeys,
    publication.objects.slice(0, 2).map((object) => object.key)
  )
  const repeated = await publish({ publication, client })
  assert.deepEqual(repeated.uploadedKeys, [])
  assert.deepEqual(
    repeated.reusedKeys,
    publication.objects.map((object) => object.key)
  )
  for (const object of publication.objects.slice(0, 2)) {
    assert.equal(
      commands.filter(
        (command) =>
          command instanceof PutObjectCommand &&
          command.input.Key === object.key
      ).length,
      1
    )
  }
})

test("preflights all immutable conflicts before uploading any new object", async (t) => {
  const publication = await createPublication({ t })
  const { client, objects, commands } = createClient()
  objects.set(
    publication.objects.at(-1).key,
    Buffer.from("conflicting release")
  )
  await assert.rejects(
    publish({ publication, client }),
    /Immutable Project publication collision/
  )
  assert.deepEqual(objects.get(currentKey), oldPointer)
  assert.equal(
    commands.some((command) => command instanceof PutObjectCommand),
    false
  )
})

test("accepts a concurrent immutable upload only when its bytes match", async (t) => {
  const publication = await createPublication({ t })
  const archiveKey = publication.objects[0].key
  let raced = false
  const { client, commands } = createClient({
    onSend: async ({ command, objects }) => {
      if (
        !raced &&
        command instanceof PutObjectCommand &&
        command.input.Key === archiveKey
      ) {
        raced = true
        objects.set(archiveKey, Buffer.from(command.input.Body))
      }
    },
  })
  const result = await publish({ publication, client })
  assert.deepEqual(result.reusedKeys, [archiveKey])
  assert.deepEqual(
    result.uploadedKeys,
    publication.objects.slice(1).map((object) => object.key)
  )
  assert.equal(commands.at(-1).input.Key, currentKey)
})

test("preserves the pointer when a concurrent immutable object conflicts", async (t) => {
  const publication = await createPublication({ t })
  const archiveKey = publication.objects[0].key
  const { client, objects } = createClient({
    onSend: async ({ command, objects }) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key === archiveKey
      ) {
        objects.set(archiveKey, Buffer.from("different concurrent export"))
      }
    },
  })
  await assert.rejects(
    publish({ publication, client }),
    /Immutable Project publication collision/
  )
  assert.deepEqual(objects.get(currentKey), oldPointer)
  assert.deepEqual(
    objects.get(archiveKey),
    Buffer.from("different concurrent export")
  )
})

test("preserves the pointer when post-upload byte verification fails", async (t) => {
  const publication = await createPublication({ t })
  const archiveKey = publication.objects[0].key
  const { client, objects } = createClient({
    onSend: async ({ command, objects }) => {
      if (
        command instanceof GetObjectCommand &&
        command.input.Key === archiveKey &&
        objects.has(archiveKey)
      ) {
        objects.set(archiveKey, Buffer.from("corrupted remote object"))
      }
    },
  })
  await assert.rejects(
    publish({ publication, client }),
    /Immutable Project publication collision/
  )
  assert.deepEqual(objects.get(currentKey), oldPointer)
})

test("revalidates all local files before contacting S3", async (t) => {
  const publication = await createPublication({ t })
  await writeFile(publication.objects.at(-1).path, "changed after build")
  const { client, commands } = createClient()
  await assert.rejects(
    publish({ publication, client }),
    /Project publication file changed/
  )
  assert.deepEqual(commands, [])
})

test("rechecks a file changed after preflight before uploading it", async (t) => {
  const publication = await createPublication({ t })
  let changed = false
  const { client, objects, commands } = createClient({
    onSend: async ({ command }) => {
      if (!changed && command instanceof GetObjectCommand) {
        changed = true
        await writeFile(publication.objects[0].path, "changed during preflight")
      }
    },
  })
  await assert.rejects(
    publish({ publication, client }),
    /Project publication file changed/
  )
  assert.equal(
    commands.some((command) => command instanceof PutObjectCommand),
    false
  )
  assert.deepEqual(objects.get(currentKey), oldPointer)
})

test("stops reading a remote collision as soon as it exceeds the expected size", async (t) => {
  const publication = await createPublication({ t })
  const archive = publication.objects[0]
  const base = createClient()
  let chunksRead = 0
  let closed = false
  async function* oversizedBody() {
    try {
      chunksRead++
      yield Buffer.alloc(archive.sizeBytes + 1)
      chunksRead++
      yield Buffer.alloc(1024)
    } finally {
      closed = true
    }
  }
  const client = {
    async send(command) {
      if (
        command instanceof GetObjectCommand &&
        command.input.Key === archive.key
      ) {
        return { Body: oversizedBody() }
      }
      return base.client.send(command)
    },
  }
  await assert.rejects(
    publish({ publication, client }),
    /Immutable Project publication collision/
  )
  assert.equal(chunksRead, 1)
  assert.equal(closed, true)
  assert.equal(
    base.commands.some((command) => command instanceof PutObjectCommand),
    false
  )
  assert.deepEqual(base.objects.get(currentKey), oldPointer)
})

test("rejects keys outside the new Project namespaces before contacting S3", async (t) => {
  const invalidKeys = [
    "manifest.json",
    "templates/app/example.tar.gz",
    "artifacts/project/example/1.0.0/../../legacy.tar.gz",
    "artifacts/project/example/1.0.0/%2e%2e.png",
    "artifacts/project/example/1.0.0/preview.svg",
    "artifacts/project/example/1.0.0/preview.gif",
    "catalogue/project/v1/releases/../current.json",
  ]
  for (const key of invalidKeys) {
    const publication = await createPublication({ t })
    publication.objects[0].key = key
    const { client, commands } = createClient()
    await assert.rejects(
      publish({ publication, client }),
      /Invalid Project publication key/
    )
    assert.deepEqual(commands, [])
  }
})

test("rejects an unsafe pointer key or incorrect object metadata", async (t) => {
  for (const field of ["key", "contentType", "cacheControl"]) {
    const publication = await createPublication({ t })
    publication.pointer[field] = "invalid"
    const { client, commands } = createClient()
    await assert.rejects(
      publish({ publication, client }),
      /Invalid Project publication/
    )
    assert.deepEqual(commands, [])
  }
})

test("does not treat denied S3 reads as missing objects", async (t) => {
  const publication = await createPublication({ t })
  const { client, objects, commands } = createClient({
    onSend: async () => {
      throw Object.assign(new Error("Access denied"), { name: "AccessDenied" })
    },
  })
  await assert.rejects(publish({ publication, client }), /Access denied/)
  assert.deepEqual(objects.get(currentKey), oldPointer)
  assert.equal(
    commands.some((command) => command instanceof PutObjectCommand),
    false
  )
})

test("rejects a pointer mixed with another release before contacting S3", async (t) => {
  const publication = await createPublication({ t })
  publication.catalogueVersion = "another-release"
  const { client, commands } = createClient()
  await assert.rejects(
    publish({ publication, client }),
    /Project publication pointer does not match its release/
  )
  assert.deepEqual(commands, [])
})

test("requires archives and exactly one immutable release for a nonempty publication", async (t) => {
  for (const removeArchives of [true, false]) {
    const publication = await createPublication({ t })
    publication.objects = publication.objects.filter((object) =>
      removeArchives
        ? !object.key.endsWith("project.tar.gz")
        : !object.key.startsWith("catalogue/")
    )
    const { client, commands } = createClient()
    await assert.rejects(
      publish({ publication, client }),
      /Project publication requires one release and Project archives/
    )
    assert.deepEqual(commands, [])
  }
})

test("skips an empty catalogue without touching S3", async () => {
  const { client, objects, commands } = createClient()
  const result = await publishProjectCatalogue({
    publication: { objects: [], pointer: null },
    client,
  })
  assert.deepEqual(result, {
    skipped: true,
    uploadedKeys: [],
    reusedKeys: [],
    pointerKey: null,
  })
  assert.deepEqual(commands, [])
  assert.deepEqual(objects.get(currentKey), oldPointer)
})
