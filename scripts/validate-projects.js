const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { buildProjectCatalogue } = require("../src/projectCatalogue")
const { getProjectOptions } = require("../src/projectOptions")

const main = async () => {
  const options = getProjectOptions()
  const outputPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "project-template-validation-")
  )
  try {
    const publication = await buildProjectCatalogue({ ...options, outputPath })
    console.log(`Validated ${publication.templates.length} Project templates.`)
  } finally {
    await fs.rm(outputPath, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
