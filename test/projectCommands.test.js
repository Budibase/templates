const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { promisify } = require("node:util")
const { execFile } = require("node:child_process")
const test = require("node:test")
const Controller = require("../src/controller")
const { getProjectOptions } = require("../src/projectOptions")

const execute = promisify(execFile)

test("the build uses the configured public origin and existing bucket", () => {
  const options = getProjectOptions({
    env: {
      AWS_REGION: "eu-west-1",
      AWS_S3_BUCKET: "templates-example",
      PROJECT_TEMPLATE_REPOSITORY_URL: "https://example.com",
      PROJECT_CATALOGUE_VERSION: "release-1",
    },
  })
  assert.equal(options.repositoryUrl, "https://example.com")
  assert.equal(options.bucket, "templates-example")
  assert.equal(options.catalogueVersion, "release-1")
})

test("the default publication origin is the regional S3 bucket", () => {
  const options = getProjectOptions({
    env: { AWS_S3_BUCKET: "templates-example" },
  })
  assert.equal(
    options.repositoryUrl,
    "https://templates-example.s3.eu-west-1.amazonaws.com"
  )
})

test("legacy discovery and manifest ignore native Project inputs", async (t) => {
  const rootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "legacy-template-review-")
  )
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  for (const type of ["app", "project"]) {
    const directory = path.join(rootPath, "templates", type, "example")
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(
      path.join(directory, "definition.json"),
      JSON.stringify({ name: type })
    )
  }
  const controller = new Controller()
  controller.rootPath = rootPath
  controller.discoverTemplates().buildManifest()
  await controller.worker.promise
  const manifest = JSON.parse(
    await fs.readFile(path.join(rootPath, "dist", "manifest.json"), "utf8")
  )
  assert.equal(controller.templates.length, 1)
  assert.deepEqual(Object.keys(manifest.templates), [
    "app",
    "qa",
    "screen",
    "component",
  ])
  assert.equal(manifest.templates.app.app.key, "app/example")
})

test("an empty build plan skips publishing without AWS configuration", async (t) => {
  const outputPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "empty-project-publication-")
  )
  t.after(() => fs.rm(outputPath, { recursive: true, force: true }))
  await fs.writeFile(
    path.join(outputPath, "publication.json"),
    JSON.stringify({ objects: [], pointer: null, templates: [] })
  )
  const env = { ...process.env, PROJECT_TEMPLATE_OUTPUT_PATH: outputPath }
  delete env.AWS_S3_BUCKET
  delete env.AWS_ACCESS_KEY_ID
  delete env.AWS_SECRET_ACCESS_KEY
  const result = await execute(
    process.execPath,
    [path.join(__dirname, "..", "scripts", "publish-projects.js")],
    { env }
  )
  assert.match(result.stdout, /existing S3 catalogue was left in place/)
})
