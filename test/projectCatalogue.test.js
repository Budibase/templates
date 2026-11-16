const { describe, it } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { gzipSync } = require("node:zlib")
const tar = require("tar")
const { buildProjectCatalogue } = require("../src/projectCatalogue")

const definition = ({ extra = {} } = {}) => ({
  version: "1.2.3",
  name: "Purchase approvals",
  description: "Approve a purchase request",
  category: "Operations",
  status: "active",
  owner: "Budibase",
  compatibility: {
    minBudibaseVersion: "4.0.0-rc.1",
    maxBudibaseVersionExclusive: "5.0.0",
    requiredFeatures: ["projects"],
  },
  ...extra,
})

const nativeEntries = ({ manifest = {}, permissions = true } = {}) => {
  const project = { _id: "project_example", name: "Purchase approvals" }
  return [
    {
      name: "manifest.json",
      value: {
        artifactType: "project",
        formatVersion: 1,
        budibaseVersion: "4.0.0-rc.1",
        exportedAt: "2026-11-09T00:00:00.000Z",
        project,
        sourceWorkspace: { id: "app_dev_example" },
        resourcesByType: { project: 1, table: 1 },
        containsRows: false,
        containsAttachments: false,
        requiresSecrets: false,
        unsupportedContent: [],
        ...(permissions ? { containsPermissions: true } : {}),
        ...manifest,
      },
    },
    { name: "project.json", value: project },
    {
      name: "dependency-index.json",
      value: {
        rootProjectId: project._id,
        directMembers: [{ id: "ta_example", name: "Requests", type: "table" }],
        resources: {
          project_example: {
            dependencies: [
              { id: "ta_example", name: "Requests", type: "table" },
            ],
          },
          ta_example: { dependencies: [] },
        },
      },
    },
    { name: "docs", type: "Directory" },
    { name: "docs/table", type: "Directory" },
    {
      name: "docs/table/ta_example.json",
      value: { _id: "ta_example", type: "table", name: "Requests", schema: {} },
    },
    ...(permissions
      ? [
          {
            name: "permissions.json",
            value: {
              resources: [
                {
                  resourceId: "ta_example",
                  levels: { read: "ADMIN", write: "ADMIN" },
                },
              ],
            },
          },
        ]
      : []),
  ]
}

const archiveBytes = ({ entries = nativeEntries() } = {}) => {
  const blocks = []
  for (const entry of entries) {
    const bytes = Buffer.from(
      entry.bytes ||
        (entry.value === undefined ? "" : JSON.stringify(entry.value))
    )
    const header = new tar.Header({
      path: entry.name,
      type: entry.type || "File",
      size: entry.size === undefined ? bytes.length : entry.size,
      mode: 0o644,
      linkpath: entry.linkpath,
    })
    header.encode()
    blocks.push(header.block, bytes)
    if (bytes.length % 512)
      blocks.push(Buffer.alloc(512 - (bytes.length % 512)))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const fixture = async ({
  t,
  slug = "purchase-approvals",
  extra = {},
  entries,
  archive,
} = {}) => {
  const rootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "project-catalogue-")
  )
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  const templatePath = path.join(rootPath, "templates/project", slug)
  await fs.mkdir(templatePath, { recursive: true })
  await fs.writeFile(
    path.join(templatePath, "definition.json"),
    JSON.stringify(definition({ extra }))
  )
  const bytes = archive || archiveBytes({ entries })
  await fs.writeFile(path.join(templatePath, "project.tar.gz"), bytes)
  const build = ({ ...options } = {}) =>
    buildProjectCatalogue({
      rootPath,
      catalogueVersion: "2026-11-09.1",
      publishedAt: "2026-11-09T12:00:00.000Z",
      ...options,
    })
  return { rootPath, templatePath, archive: bytes, build }
}

const hash = ({ bytes }) => createHash("sha256").update(bytes).digest("hex")

describe("Project catalogue builder", () => {
  it("preserves native export bytes and hashes the exact catalogue for the pointer", async (t) => {
    const f = await fixture({
      t,
      entries: nativeEntries({ permissions: true }),
    })
    const result = await f.build()
    assert.equal(result.templates[0].key, "project/purchase-approvals")
    assert.equal(result.templates[0].artifact.packageVersion, 1)
    assert.equal(
      result.templates[0].artifact.sha256,
      hash({ bytes: f.archive })
    )
    const archive = result.objects.find((object) =>
      object.key.endsWith("project.tar.gz")
    )
    assert.deepEqual(await fs.readFile(archive.path), f.archive)
    assert.equal(archive.contentType, "application/gzip")
    assert.equal(archive.cacheControl, "public,max-age=31536000,immutable")
    assert.equal(archive.sizeBytes, f.archive.length)
    const catalogue = result.objects.find((object) =>
      object.key.includes("/releases/")
    )
    const bytes = await fs.readFile(catalogue.path)
    assert.equal(catalogue.sha256, hash({ bytes }))
    assert.deepEqual(JSON.parse(bytes), {
      schemaVersion: 1,
      catalogueVersion: result.catalogueVersion,
      publishedAt: result.publishedAt,
      templates: result.templates,
    })
    const pointerBytes = await fs.readFile(result.pointer.path)
    assert.deepEqual(JSON.parse(pointerBytes), {
      schemaVersion: 1,
      catalogueVersion: result.catalogueVersion,
      sha256: hash({ bytes }),
    })
    assert.equal(result.pointer.sha256, hash({ bytes: pointerBytes }))
    assert.equal(result.pointer.cacheControl, "no-cache")
  })

  it("accepts the directory layout and metadata produced by native tar.create exports", async (t) => {
    const f = await fixture({ t })
    const staging = path.join(f.rootPath, "native-export")
    await fs.mkdir(staging)
    for (const entry of nativeEntries({ permissions: true })) {
      const target = path.join(staging, entry.name)
      if (entry.type === "Directory")
        await fs.mkdir(target, { recursive: true })
      else await fs.writeFile(target, JSON.stringify(entry.value))
    }
    await tar.create(
      {
        gzip: true,
        cwd: staging,
        file: path.join(f.templatePath, "project.tar.gz"),
      },
      await fs.readdir(staging)
    )
    const result = await f.build()
    assert.equal(result.templates[0].artifact.packageVersion, 1)
  })

  it("copies local previews under the immutable template version", async (t) => {
    const f = await fixture({ t, extra: { image: "preview.png" } })
    const preview = Buffer.from("local preview bytes")
    await fs.writeFile(path.join(f.templatePath, "preview.png"), preview)
    const result = await f.build({
      repositoryUrl: "https://example.com",
    })
    assert.equal(
      result.templates[0].image,
      "https://example.com/artifacts/project/purchase-approvals/1.2.3/preview.png"
    )
    const image = result.objects.find((object) =>
      object.key.endsWith("preview.png")
    )
    assert.deepEqual(await fs.readFile(image.path), preview)
    assert.equal(image.contentType, "image/png")
    assert.equal(image.sha256, hash({ bytes: preview }))
  })

  it("normalises the published image extension while reading the original filename", async (t) => {
    const f = await fixture({ t, extra: { image: "preview.PNG" } })
    await fs.writeFile(path.join(f.templatePath, "preview.PNG"), "preview")
    const result = await f.build({ repositoryUrl: "https://example.com" })
    const image = result.objects.find(
      (object) => object.contentType === "image/png"
    )
    assert.equal(
      image.key,
      "artifacts/project/purchase-approvals/1.2.3/preview.png"
    )
    assert.equal(result.templates[0].image, `https://example.com/${image.key}`)
    assert.equal((await fs.readFile(image.path)).toString(), "preview")
  })

  it("validates an origin-only repository URL even without a local preview", async (t) => {
    const f = await fixture({ t })
    await assert.rejects(
      f.build({ repositoryUrl: "https://example.com/templates" }),
      /origin/
    )
    await assert.rejects(
      f.build({ repositoryUrl: "http://example.com" }),
      /HTTPS/
    )
    await assert.rejects(
      f.build({ repositoryUrl: "https://example.com?version=1" }),
      /query/
    )
  })

  it("keeps absolute HTTPS previews unchanged", async (t) => {
    const image = "https://example.com/preview.png?version=1#preview"
    const f = await fixture({ t, extra: { image } })
    const result = await f.build()
    assert.equal(result.templates[0].image, image)
    assert.equal(result.objects.length, 2)
  })

  it("requires an HTTPS repository root for local previews", async (t) => {
    const f = await fixture({ t, extra: { image: "preview.png" } })
    await fs.writeFile(path.join(f.templatePath, "preview.png"), "image")
    await assert.rejects(f.build(), /repositoryUrl is required/)
    await assert.rejects(
      f.build({ repositoryUrl: "http://example.com" }),
      /HTTPS/
    )
    await assert.rejects(
      f.build({ repositoryUrl: "https://example.com?token=secret" }),
      /query/
    )
  })

  it("sorts templates and objects stably with reproducible publication bytes", async (t) => {
    const f = await fixture({ t, slug: "zebra" })
    const alpha = path.join(f.rootPath, "templates/project/alpha")
    await fs.mkdir(alpha)
    await fs.writeFile(
      path.join(alpha, "definition.json"),
      JSON.stringify(definition())
    )
    await fs.writeFile(path.join(alpha, "project.tar.gz"), f.archive)
    const first = await f.build()
    const second = await f.build({ outputPath: "another-output" })
    assert.deepEqual(
      first.templates.map((template) => template.slug),
      ["alpha", "zebra"]
    )
    assert.deepEqual(
      first.objects.map((object) => object.key),
      [...first.objects.map((object) => object.key)].sort()
    )
    assert.deepEqual(
      first.objects.map((object) => object.sha256),
      second.objects.map((object) => object.sha256)
    )
    assert.equal(first.pointer.sha256, second.pointer.sha256)
  })

  it("does not emit or promote a catalogue when no production templates exist", async (t) => {
    const rootPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-catalogue-empty-")
    )
    t.after(() => fs.rm(rootPath, { recursive: true, force: true }))
    const result = await buildProjectCatalogue({
      rootPath,
      catalogueVersion: "empty",
    })
    assert.deepEqual(result.templates, [])
    assert.deepEqual(result.objects, [])
    assert.equal(result.pointer, null)
    await assert.rejects(fs.access(path.join(rootPath, "dist/project")), {
      code: "ENOENT",
    })
  })

  for (const { name, extra, message } of [
    { name: "missing owner", extra: { owner: undefined }, message: /owner/ },
    {
      name: "prerelease content version",
      extra: { version: "1.0.0-rc.1" },
      message: /version/,
    },
    {
      name: "invalid semver",
      extra: {
        compatibility: { minBudibaseVersion: "latest", requiredFeatures: [] },
      },
      message: /semver/,
    },
    {
      name: "backwards compatibility interval",
      extra: {
        compatibility: {
          minBudibaseVersion: "4.0.0",
          maxBudibaseVersionExclusive: "3.0.0",
          requiredFeatures: [],
        },
      },
      message: /interval/,
    },
    {
      name: "unsupported feature",
      extra: {
        compatibility: {
          minBudibaseVersion: "4.0.0",
          requiredFeatures: ["agents"],
        },
      },
      message: /supported projects feature/,
    },
    {
      name: "duplicate feature",
      extra: {
        compatibility: {
          minBudibaseVersion: "4.0.0",
          requiredFeatures: ["projects", "projects"],
        },
      },
      message: /duplicates/,
    },
    {
      name: "unsafe colour",
      extra: { background: "red" },
      message: /background/,
    },
    {
      name: "missing deprecation explanation",
      extra: { status: "deprecated" },
      message: /deprecation/,
    },
    {
      name: "unexpected deprecation",
      extra: { deprecation: { message: "Old" } },
      message: /deprecated/,
    },
    {
      name: "local preview traversal",
      extra: { image: "../preview.png" },
      message: /filename/,
    },
    {
      name: "insecure preview",
      extra: { image: "http://example.com/a.png" },
      message: /filename/,
    },
  ]) {
    it(`rejects ${name}`, async (t) => {
      const f = await fixture({ t, extra })
      await assert.rejects(f.build(), message)
    })
  }

  it("supports deprecated and withdrawn entries without making them active", async (t) => {
    const f = await fixture({
      t,
      extra: {
        status: "deprecated",
        deprecation: {
          message: "Use the replacement",
          replacementKey: "project/replacement",
        },
      },
    })
    const result = await f.build()
    assert.equal(result.templates[0].status, "deprecated")
    assert.equal(
      result.templates[0].deprecation.replacementKey,
      "project/replacement"
    )
    await fs.writeFile(
      path.join(f.templatePath, "definition.json"),
      JSON.stringify(definition({ extra: { status: "withdrawn" } }))
    )
    assert.equal((await f.build()).templates[0].status, "withdrawn")
  })

  for (const { name, entries, archive, message } of [
    {
      name: "legacy workspace package",
      entries: [{ name: "db.txt", bytes: "workspace" }],
      message: /native Project layout/,
    },
    {
      name: "encrypted package",
      archive: Buffer.from("encrypted export"),
      message: /unencrypted gzip/,
    },
    {
      name: "encrypted resource document",
      entries: nativeEntries().map((entry) =>
        entry.name === "docs/table/ta_example.json"
          ? { name: entry.name, bytes: "ENCRYPTED" }
          : entry
      ),
      message: /unencrypted JSON/,
    },
    {
      name: "missing declared rows",
      entries: nativeEntries({ manifest: { containsRows: true } }),
      message: /data.json/,
    },
    {
      name: "encrypted manifest",
      entries: nativeEntries().map((entry) =>
        entry.name === "manifest.json"
          ? { name: entry.name, bytes: "ENCRYPTED" }
          : entry
      ),
      message: /unencrypted JSON/,
    },
    {
      name: "wrong manifest artefact",
      entries: nativeEntries({ manifest: { artifactType: "workspace" } }),
      message: /native Project manifest/,
    },
    {
      name: "unsupported format",
      entries: nativeEntries({ manifest: { formatVersion: 2 } }),
      message: /native Project manifest/,
    },
    {
      name: "malformed manifest",
      entries: nativeEntries({ manifest: { resourcesByType: { table: -1 } } }),
      message: /native Project manifest/,
    },
    {
      name: "missing docs directory",
      entries: nativeEntries().filter((entry) => entry.name !== "docs"),
      message: /docs directory/,
    },
    {
      name: "missing required file",
      entries: nativeEntries().filter((entry) => entry.name !== "project.json"),
      message: /missing project.json/,
    },
    {
      name: "traversal",
      entries: [...nativeEntries(), { name: "../escape", bytes: "escape" }],
      message: /unsafe path/,
    },
    {
      name: "absolute path",
      entries: [...nativeEntries(), { name: "/escape", bytes: "escape" }],
      message: /unsafe path/,
    },
    {
      name: "symlink",
      entries: [
        ...nativeEntries(),
        {
          name: "docs/table/link.json",
          type: "SymbolicLink",
          linkpath: "../../../outside",
        },
      ],
      message: /link/,
    },
    {
      name: "hardlink",
      entries: [
        ...nativeEntries(),
        {
          name: "docs/table/link.json",
          type: "Link",
          linkpath: "project.json",
        },
      ],
      message: /link/,
    },
    {
      name: "duplicate files",
      entries: [...nativeEntries(), nativeEntries()[0]],
      message: /duplicate/,
    },
    {
      name: "expanded size overflow",
      entries: [
        ...nativeEntries(),
        { name: "attachments/huge", size: 100 * 1024 * 1024 + 1 },
      ],
      message: /100 MiB/,
    },
    {
      name: "pre-permission native export",
      entries: nativeEntries({ permissions: false }),
      message: /permission-aware/,
    },
    {
      name: "missing root dependency entry",
      entries: nativeEntries().map((entry) =>
        entry.name === "dependency-index.json"
          ? {
              ...entry,
              value: {
                ...entry.value,
                resources: { ta_example: { dependencies: [] } },
              },
            }
          : entry
      ),
      message: /root dependency index/,
    },
    {
      name: "incorrect manifest resource counts",
      entries: nativeEntries({ manifest: { resourcesByType: { table: 1 } } }),
      message: /resource count mismatch/,
    },
    {
      name: "missing declared permissions",
      entries: nativeEntries({
        manifest: { containsPermissions: true },
        permissions: false,
      }),
      message: /permissions.json/,
    },
  ]) {
    it(`rejects ${name} without extracting it`, async (t) => {
      const f = await fixture({ t, entries, archive })
      await assert.rejects(f.build(), message)
      await assert.rejects(fs.access(path.join(f.rootPath, "dist/project")), {
        code: "ENOENT",
      })
    })
  }

  it("rejects too many archive entries", async (t) => {
    const entries = [
      ...nativeEntries(),
      ...Array.from({ length: 2000 }, (_value, index) => ({
        name: `docs/d${index}`,
        type: "Directory",
      })),
    ]
    const f = await fixture({ t, entries })
    await assert.rejects(f.build(), /2000 entries/)
  })

  it("rejects compressed archives larger than 50 MiB before reading them", async (t) => {
    const f = await fixture({ t })
    await fs.truncate(
      path.join(f.templatePath, "project.tar.gz"),
      50 * 1024 * 1024 + 1
    )
    await assert.rejects(f.build(), /allowed size/)
  })

  it("rejects linked previews and archives", async (t) => {
    const f = await fixture({ t, extra: { image: "preview.png" } })
    const external = path.join(f.rootPath, "external.png")
    await fs.writeFile(external, "external")
    await fs.symlink(external, path.join(f.templatePath, "preview.png"))
    await assert.rejects(
      f.build({ repositoryUrl: "https://example.com" }),
      /regular file/
    )
    await fs.unlink(path.join(f.templatePath, "project.tar.gz"))
    await fs.symlink(external, path.join(f.templatePath, "project.tar.gz"))
    await assert.rejects(f.build(), /regular file/)
  })

  it("rejects catalogue versions that would escape immutable release paths", async (t) => {
    const f = await fixture({ t })
    for (const catalogueVersion of [undefined, "../escape", "", "a".repeat(65)])
      await assert.rejects(f.build({ catalogueVersion }), /catalogueVersion/)
  })

  it("rejects a catalogue larger than the consumer's 1 MiB limit", async (t) => {
    const f = await fixture({ t })
    const metadata = definition({
      extra: {
        name: "n".repeat(100),
        description: "d".repeat(500),
        category: "c".repeat(80),
        owner: "o".repeat(100),
      },
    })
    for (let index = 0; index < 1050; index++) {
      const folder = path.join(
        f.rootPath,
        "templates/project",
        `entry-${index}`
      )
      await fs.mkdir(folder)
      await fs.writeFile(
        path.join(folder, "definition.json"),
        JSON.stringify(metadata)
      )
      await fs.link(
        path.join(f.templatePath, "project.tar.gz"),
        path.join(folder, "project.tar.gz")
      )
    }
    await assert.rejects(f.build(), /catalogue exceeds 1 MiB/)
    await assert.rejects(fs.access(path.join(f.rootPath, "dist/project")), {
      code: "ENOENT",
    })
  })
})
