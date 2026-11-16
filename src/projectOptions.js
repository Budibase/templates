const path = require("node:path")

const getProjectOptions = ({ env = process.env } = {}) => {
  const rootPath = path.resolve(__dirname, "..")
  const region = env.AWS_REGION || "eu-west-1"
  const bucket = env.AWS_S3_BUCKET
  const repositoryUrl =
    env.PROJECT_TEMPLATE_REPOSITORY_URL ||
    (bucket
      ? `https://${bucket}.s3.${region}.amazonaws.com`
      : "https://prod-budi-templates.s3-eu-west-1.amazonaws.com")

  return {
    rootPath,
    outputPath: path.resolve(
      env.PROJECT_TEMPLATE_OUTPUT_PATH || path.join(rootPath, "dist", "project")
    ),
    catalogueVersion:
      env.PROJECT_CATALOGUE_VERSION ||
      new Date().toISOString().replace(/[:.]/g, "-"),
    publishedAt: env.PROJECT_CATALOGUE_PUBLISHED_AT || new Date().toISOString(),
    repositoryUrl,
    bucket,
    region,
  }
}

module.exports = { getProjectOptions }
