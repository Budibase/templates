const fs = require("node:fs/promises")
const path = require("node:path")
const { getProjectOptions } = require("../src/projectOptions")
const { publishProjectCatalogue } = require("../src/projectPublisher")

const main = async () => {
  const options = getProjectOptions()
  const publication = JSON.parse(
    await fs.readFile(path.join(options.outputPath, "publication.json"), "utf8")
  )
  if (publication.targetBucket && options.bucket !== publication.targetBucket) {
    throw new Error(
      "AWS_S3_BUCKET differs from the bucket used to build this catalogue."
    )
  }
  const result = await publishProjectCatalogue({
    publication,
    bucket: options.bucket,
    region: options.region,
  })
  if (result.skipped) {
    console.log(
      "No Project templates found; the existing S3 catalogue was left in place."
    )
    return
  }
  console.log(
    `Published Project catalogue ${publication.catalogueVersion} to ${options.bucket}.`
  )
  console.log(`Repository URL: ${publication.repositoryUrl}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
