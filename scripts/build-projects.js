const fs = require("node:fs/promises")
const path = require("node:path")
const { buildProjectCatalogue } = require("../src/projectCatalogue")
const { getProjectOptions } = require("../src/projectOptions")

const main = async () => {
  const options = getProjectOptions()
  const publication = await buildProjectCatalogue(options)
  await fs.mkdir(options.outputPath, { recursive: true })
  await fs.writeFile(
    path.join(options.outputPath, "publication.json"),
    JSON.stringify(
      {
        ...publication,
        repositoryUrl: options.repositoryUrl,
        targetBucket: options.bucket,
      },
      null,
      2
    ) + "\n"
  )
  if (!publication.pointer) {
    console.log(
      "No Project templates found; catalogue publication will be skipped."
    )
    return
  }
  console.log(
    `Built ${publication.templates.length} Project templates in catalogue ${publication.catalogueVersion}.`
  )
  console.log(`Review the publication in ${options.outputPath}.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
