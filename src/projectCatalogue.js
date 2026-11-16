const fs = require("node:fs/promises")
const { createHash } = require("node:crypto")
const path = require("node:path")
const { Readable, Transform } = require("node:stream")
const { pipeline } = require("node:stream/promises")
const { createGunzip } = require("node:zlib")
const semver = require("semver")
const tar = require("tar")

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024
const MAX_ENTRIES = 2000
const MAX_CATALOGUE_BYTES = 1024 * 1024
const IMMUTABLE_CACHE_CONTROL = "public,max-age=31536000,immutable"
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/
const CATALOGUE_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const ROOT_FILES = new Set([
  "manifest.json",
  "project.json",
  "dependency-index.json",
  "permissions.json",
  "data.json",
])
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}

const isRecord = ({ value }) =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const fail = ({ message }) => {
  throw new Error(message)
}

const compare = ({ left, right }) => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const requiredString = ({ value, field, maxLength }) => {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    fail({
      message: `${field} must be a nonempty string of at most ${maxLength} characters`,
    })
  }
  return value.trim()
}

const optionalString = ({ value, ...options }) =>
  value === undefined ? undefined : requiredString({ value, ...options })

const httpsUrl = ({ value, field, repositoryRoot = false }) => {
  const result = requiredString({ value, field, maxLength: 2048 })
  let url
  try {
    url = new URL(result)
  } catch {
    fail({ message: `${field} must be an absolute HTTPS URL` })
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (repositoryRoot && (url.search || url.hash || url.pathname !== "/"))
  ) {
    fail({
      message: `${field} must be an HTTPS origin without credentials, path, query or fragment`,
    })
  }
  return result
}

const parseJson = ({ bytes, filename }) => {
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    fail({ message: `${filename} must contain valid unencrypted JSON` })
  }
}

const readFile = async ({ filename, maxBytes }) => {
  const info = await fs.lstat(filename)
  if (!info.isFile() || info.isSymbolicLink()) {
    fail({ message: `${filename} must be a regular file` })
  }
  if (info.size <= 0 || (maxBytes !== undefined && info.size > maxBytes)) {
    fail({ message: `${filename} is empty or exceeds the allowed size` })
  }
  const bytes = await fs.readFile(filename)
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    fail({ message: `${filename} exceeds the allowed size` })
  }
  return bytes
}

const validateManifest = ({
  manifest,
  project,
  dependencyIndex,
  paths,
  data,
}) => {
  if (
    !isRecord({ value: manifest }) ||
    manifest.artifactType !== "project" ||
    manifest.formatVersion !== 1 ||
    !isRecord({ value: manifest.sourceWorkspace }) ||
    typeof manifest.sourceWorkspace.id !== "string" ||
    !manifest.sourceWorkspace.id.startsWith("app_dev_") ||
    !isRecord({ value: manifest.resourcesByType }) ||
    !Object.values(manifest.resourcesByType).every(
      (count) => Number.isInteger(count) && count >= 0
    ) ||
    typeof manifest.containsRows !== "boolean" ||
    typeof manifest.containsAttachments !== "boolean" ||
    !Array.isArray(manifest.unsupportedContent) ||
    !manifest.unsupportedContent.every(
      (item) =>
        isRecord({ value: item }) &&
        typeof item.type === "string" &&
        Number.isInteger(item.count) &&
        item.count >= 0 &&
        typeof item.reason === "string"
    ) ||
    (manifest.containsPermissions !== undefined &&
      typeof manifest.containsPermissions !== "boolean")
  ) {
    fail({
      message: "manifest.json is not a supported native Project manifest",
    })
  }
  if (
    !isRecord({ value: project }) ||
    typeof project._id !== "string" ||
    !project._id.startsWith("project_") ||
    typeof project.name !== "string" ||
    !isRecord({ value: dependencyIndex }) ||
    dependencyIndex.rootProjectId !== project._id ||
    !Array.isArray(dependencyIndex.directMembers) ||
    !isRecord({ value: dependencyIndex.resources })
  ) {
    fail({
      message:
        "project.json or dependency-index.json is not a native Project document",
    })
  }
  if (
    manifest.containsPermissions !== true ||
    paths.get("permissions.json") !== "file"
  ) {
    fail({
      message:
        "Fresh permission-aware exports require containsPermissions: true and permissions.json",
    })
  }
  if (
    data !== undefined &&
    (!isRecord({ value: data }) ||
      !Array.isArray(data.rows) ||
      !Array.isArray(data.relationships) ||
      !Array.isArray(data.attachments))
  ) {
    fail({ message: "data.json is not native Project data" })
  }
  if (
    manifest.containsRows !== !!data?.rows.length ||
    manifest.containsAttachments !== !!data?.attachments.length
  ) {
    fail({ message: "data.json does not match the native manifest" })
  }
}

const validateResources = ({
  manifest,
  project,
  dependencyIndex,
  documents,
}) => {
  const prefixes = {
    agent: "agent_",
    datasource: "datasource_",
    table: "ta_",
    query: "query_",
    automation: "au_",
    row_action: "ra_",
    workspace_app: "workspace_app_",
    screen: "screen_",
  }
  const actualTypes = new Map([[project._id, "project"]])
  const counts = Object.assign(Object.create(null), { project: 1 })
  for (const { filename, value } of documents) {
    const parts = filename.split("/")
    const type = parts[1]
    if (
      parts.length !== 3 ||
      !Object.hasOwn(prefixes, type) ||
      parts[2] !== `${value._id}.json` ||
      !value._id.startsWith(prefixes[type]) ||
      actualTypes.has(value._id)
    ) {
      fail({
        message: `Project resource document does not match its path: ${filename}`,
      })
    }
    actualTypes.set(value._id, type)
    counts[type] = (counts[type] || 0) + 1
  }
  const indexed = dependencyIndex.resources
  if (
    !isRecord({ value: indexed[project._id] }) ||
    Object.keys(indexed).length !== actualTypes.size ||
    Object.keys(indexed).some((id) => !actualTypes.has(id))
  ) {
    fail({ message: "Project docs do not match the root dependency index" })
  }
  const references = [...dependencyIndex.directMembers]
  for (const resource of Object.values(indexed)) {
    if (!isRecord({ value: resource }) || !Array.isArray(resource.dependencies))
      fail({
        message: "Project dependency entries must contain dependency arrays",
      })
    references.push(...resource.dependencies)
  }
  if (
    references.some(
      (resource) =>
        !isRecord({ value: resource }) ||
        typeof resource.id !== "string" ||
        typeof resource.name !== "string" ||
        typeof resource.type !== "string" ||
        !actualTypes.has(resource.id) ||
        actualTypes.get(resource.id) !== resource.type
    ) ||
    dependencyIndex.directMembers.some(
      (resource) => resource.id === project._id
    )
  ) {
    fail({ message: "Project dependency references do not match package docs" })
  }
  const reachable = new Set()
  const pending = [project._id]
  while (pending.length) {
    const id = pending.pop()
    if (reachable.has(id)) continue
    reachable.add(id)
    pending.push(...indexed[id].dependencies.map((resource) => resource.id))
  }
  if (reachable.size !== actualTypes.size)
    fail({
      message: "Project docs must be reachable from the root dependency entry",
    })
  for (const type of new Set([
    ...Object.keys(counts),
    ...Object.keys(manifest.resourcesByType),
  ])) {
    if ((counts[type] || 0) !== (manifest.resourcesByType[type] || 0))
      fail({ message: `Project resource count mismatch for ${type}` })
  }
}

const validateArchive = async ({ bytes }) => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    fail({
      message:
        "project.tar.gz must be an unencrypted gzip native Project export",
    })
  }
  const paths = new Map()
  const rootJson = new Map()
  let entries = 0
  let expandedBytes = 0
  let tarBytes = 0
  let validationError
  let parser
  parser = tar.list({
    strict: true,
    onReadEntry: (entry) => {
      try {
        entries++
        if (entries > MAX_ENTRIES)
          fail({ message: "Project archive exceeds 2000 entries" })
        const name = entry.path.replace(/\/$/, "")
        const parts = name.split(/[\\/]/)
        if (
          !name ||
          name.startsWith("/") ||
          name.startsWith("\\") ||
          /^[a-zA-Z]:/.test(name) ||
          parts.some((part) => !part || part === "." || part === "..") ||
          name.includes("\\") ||
          parts.length > 4
        ) {
          fail({
            message: `Project archive contains an unsafe path: ${entry.path}`,
          })
        }
        if (paths.has(name))
          fail({
            message: `Project archive contains a duplicate entry: ${name}`,
          })
        if (
          ![
            "File",
            "OldFile",
            "ContiguousFile",
            "Directory",
            "GNUDumpDir",
          ].includes(entry.type)
        ) {
          fail({
            message: `Project archive contains an unsupported entry or link: ${name}`,
          })
        }
        const directory =
          entry.type === "Directory" || entry.type === "GNUDumpDir"
        if (
          (parts.length === 1 &&
            !(directory
              ? ["docs", "attachments"].includes(name)
              : ROOT_FILES.has(name))) ||
          (parts.length > 1 && !["docs", "attachments"].includes(parts[0])) ||
          (!directory && parts[0] === "docs" && !name.endsWith(".json"))
        ) {
          fail({
            message: `Project archive contains a file outside the native Project layout: ${name}`,
          })
        }
        paths.set(name, directory ? "directory" : "file")
        if (!directory) {
          expandedBytes += entry.size
          if (
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            expandedBytes > MAX_EXPANDED_BYTES
          ) {
            fail({ message: "Project archive exceeds 100 MiB expanded" })
          }
        }
        if (!directory && (ROOT_FILES.has(name) || name.startsWith("docs/"))) {
          const chunks = []
          entry.on("data", (chunk) => chunks.push(chunk))
          entry.on("end", () => rootJson.set(name, Buffer.concat(chunks)))
        }
      } catch (error) {
        validationError = error
        parser.abort(error)
      }
    },
  })
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      tarBytes += chunk.length
      if (tarBytes > MAX_EXPANDED_BYTES + MAX_ENTRIES * 1024 + 1024) {
        callback(new Error("Project archive exceeds the expanded size limit"))
      } else {
        callback(null, chunk)
      }
    },
  })
  try {
    await pipeline(Readable.from([bytes]), createGunzip(), limiter, parser)
  } catch (error) {
    throw (
      validationError ||
      new Error(`Invalid native Project archive: ${error.message}`)
    )
  }
  for (const filename of [
    "manifest.json",
    "project.json",
    "dependency-index.json",
  ]) {
    if (paths.get(filename) !== "file")
      fail({ message: `Project archive is missing ${filename}` })
  }
  if (paths.get("docs") !== "directory")
    fail({ message: "Project archive is missing its docs directory" })
  const manifest = parseJson({
    bytes: rootJson.get("manifest.json"),
    filename: "manifest.json",
  })
  const project = parseJson({
    bytes: rootJson.get("project.json"),
    filename: "project.json",
  })
  const dependencyIndex = parseJson({
    bytes: rootJson.get("dependency-index.json"),
    filename: "dependency-index.json",
  })
  let data
  const documents = []
  for (const [filename, bytes] of rootJson) {
    if (
      filename.startsWith("docs/") ||
      filename === "permissions.json" ||
      filename === "data.json"
    ) {
      const value = parseJson({ bytes, filename })
      if (filename === "data.json") data = value
      if (
        filename === "permissions.json" &&
        (!isRecord({ value }) || !Array.isArray(value.resources))
      )
        fail({
          message: "permissions.json must contain a native permission snapshot",
        })
      if (filename.startsWith("docs/")) documents.push({ filename, value })
      if (
        filename.startsWith("docs/") &&
        (!isRecord({ value }) || typeof value._id !== "string")
      )
        fail({
          message: `${filename} is not a native Project resource document`,
        })
    }
  }
  validateManifest({ manifest, project, dependencyIndex, paths, data })
  validateResources({ manifest, project, dependencyIndex, documents })
  return manifest.formatVersion
}

const readCompatibility = ({ value }) => {
  if (!isRecord({ value })) fail({ message: "compatibility is required" })
  const minBudibaseVersion = requiredString({
    value: value.minBudibaseVersion,
    field: "compatibility.minBudibaseVersion",
    maxLength: 64,
  })
  const maxBudibaseVersionExclusive = optionalString({
    value: value.maxBudibaseVersionExclusive,
    field: "compatibility.maxBudibaseVersionExclusive",
    maxLength: 64,
  })
  if (
    !semver.valid(minBudibaseVersion) ||
    (maxBudibaseVersionExclusive &&
      (!semver.valid(maxBudibaseVersionExclusive) ||
        !semver.lt(minBudibaseVersion, maxBudibaseVersionExclusive)))
  ) {
    fail({
      message: "compatibility must define a valid increasing semver interval",
    })
  }
  if (
    !Array.isArray(value.requiredFeatures) ||
    value.requiredFeatures.some((feature) => feature !== "projects") ||
    new Set(value.requiredFeatures).size !== value.requiredFeatures.length
  ) {
    fail({
      message:
        "compatibility.requiredFeatures must contain only the supported projects feature, without duplicates",
    })
  }
  return {
    minBudibaseVersion,
    ...(maxBudibaseVersionExclusive ? { maxBudibaseVersionExclusive } : {}),
    requiredFeatures: [...value.requiredFeatures],
  }
}

const readDefinition = ({ value, slug }) => {
  if (!isRecord({ value }))
    fail({ message: `${slug}/definition.json must be an object` })
  const version = requiredString({
    value: value.version,
    field: "version",
    maxLength: 64,
  })
  if (!VERSION_PATTERN.test(version) || !semver.valid(version))
    fail({ message: "version must be an exact major.minor.patch version" })
  const status = requiredString({
    value: value.status,
    field: "status",
    maxLength: 20,
  })
  if (!["active", "deprecated", "withdrawn"].includes(status))
    fail({ message: "status must be active, deprecated or withdrawn" })
  const result = {
    key: `project/${slug}`,
    slug,
    version,
    name: requiredString({ value: value.name, field: "name", maxLength: 100 }),
    description: requiredString({
      value: value.description,
      field: "description",
      maxLength: 500,
    }),
    category: requiredString({
      value: value.category,
      field: "category",
      maxLength: 80,
    }),
    status,
    owner: requiredString({
      value: value.owner,
      field: "owner",
      maxLength: 100,
    }),
    compatibility: readCompatibility({ value: value.compatibility }),
  }
  for (const [field, maxLength] of [
    ["icon", 80],
    ["background", 7],
  ]) {
    const text = optionalString({ value: value[field], field, maxLength })
    if (text !== undefined) result[field] = text
  }
  if (result.background && !/^#[a-fA-F0-9]{6}$/.test(result.background))
    fail({ message: "background must be a six-digit hex colour" })
  if (status === "deprecated") {
    if (!isRecord({ value: value.deprecation }))
      fail({ message: "deprecated templates require deprecation details" })
    result.deprecation = {
      message: requiredString({
        value: value.deprecation.message,
        field: "deprecation.message",
        maxLength: 500,
      }),
    }
    const replacementKey = optionalString({
      value: value.deprecation.replacementKey,
      field: "deprecation.replacementKey",
      maxLength: 200,
    })
    if (
      replacementKey &&
      !/^project\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(replacementKey)
    )
      fail({
        message: "deprecation.replacementKey must be a Project template key",
      })
    if (replacementKey) result.deprecation.replacementKey = replacementKey
  } else if (value.deprecation !== undefined) {
    fail({
      message: "only deprecated templates may define deprecation details",
    })
  }
  return result
}

const objectDescriptor = async ({
  outputPath,
  key,
  bytes,
  sourcePath,
  expectedSha256,
  expectedSizeBytes,
  contentType,
  cacheControl = IMMUTABLE_CACHE_CONTROL,
}) => {
  const filename = path.join(outputPath, ...key.split("/"))
  await fs.mkdir(path.dirname(filename), { recursive: true })
  if (sourcePath) {
    await fs.copyFile(sourcePath, filename)
    bytes = await readFile({ filename, maxBytes: MAX_ARCHIVE_BYTES })
    if (
      bytes.length !== expectedSizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    ) {
      fail({
        message: `Template input changed during the build: ${sourcePath}`,
      })
    }
  } else {
    await fs.writeFile(filename, bytes)
  }
  return {
    key,
    path: filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    contentType,
    cacheControl,
  }
}

const buildProjectCatalogue = async ({
  rootPath = process.cwd(),
  outputPath,
  catalogueVersion,
  publishedAt = new Date().toISOString(),
  repositoryUrl,
}) => {
  if (
    typeof catalogueVersion !== "string" ||
    !CATALOGUE_VERSION_PATTERN.test(catalogueVersion)
  )
    fail({
      message:
        "catalogueVersion must be an explicit safe version token of 1–64 characters",
    })
  if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt)))
    fail({ message: "publishedAt must be a valid date string" })
  publishedAt = new Date(publishedAt).toISOString()
  const repositoryRoot =
    repositoryUrl === undefined
      ? undefined
      : httpsUrl({
          value: repositoryUrl,
          field: "repositoryUrl",
          repositoryRoot: true,
        })
  rootPath = path.resolve(rootPath)
  outputPath = path.resolve(rootPath, outputPath || "dist/project")
  const templateRoot = path.join(rootPath, "templates/project")
  let folders
  try {
    folders = await fs.readdir(templateRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    folders = []
  }
  const templates = []
  const pendingObjects = []
  for (const folder of folders.sort((a, b) =>
    compare({ left: a.name, right: b.name })
  )) {
    if (folder.isSymbolicLink())
      fail({ message: "Project template folders must not be symbolic links" })
    if (!folder.isDirectory()) continue
    const slug = folder.name
    if (slug.length > 160 || !SLUG_PATTERN.test(slug))
      fail({ message: `Invalid Project template slug: ${slug}` })
    const folderPath = path.join(templateRoot, slug)
    const definition = parseJson({
      bytes: await readFile({
        filename: path.join(folderPath, "definition.json"),
        maxBytes: MAX_CATALOGUE_BYTES,
      }),
      filename: `${slug}/definition.json`,
    })
    const template = readDefinition({ value: definition, slug })
    const archive = await readFile({
      filename: path.join(folderPath, "project.tar.gz"),
      maxBytes: MAX_ARCHIVE_BYTES,
    })
    const packageVersion = await validateArchive({ bytes: archive })
    const artifactKey = `artifacts/project/${slug}/${template.version}/project.tar.gz`
    template.artifact = {
      packageVersion,
      sizeBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
    }
    pendingObjects.push({
      key: artifactKey,
      sourcePath: path.join(folderPath, "project.tar.gz"),
      expectedSha256: template.artifact.sha256,
      expectedSizeBytes: archive.length,
      contentType: "application/gzip",
    })
    if (definition.image !== undefined) {
      const image = requiredString({
        value: definition.image,
        field: "image",
        maxLength: 2048,
      })
      if (/^https:\/\//i.test(image)) {
        template.image = httpsUrl({ value: image, field: "image" })
      } else {
        const extension = path.extname(image).toLowerCase()
        if (
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(image) ||
          !IMAGE_TYPES[extension]
        )
          fail({
            message: "local image must be a single PNG, JPEG or WebP filename",
          })
        if (!repositoryUrl)
          fail({
            message: "repositoryUrl is required for local template images",
          })
        const publishedImage =
          image.slice(0, -path.extname(image).length) + extension
        const key = `artifacts/project/${slug}/${template.version}/${publishedImage}`
        template.image = new URL(
          key,
          `${repositoryRoot.replace(/\/$/, "")}/`
        ).toString()
        const imagePath = path.join(folderPath, image)
        const imageBytes = await readFile({
          filename: imagePath,
          maxBytes: MAX_ARCHIVE_BYTES,
        })
        pendingObjects.push({
          key,
          sourcePath: imagePath,
          expectedSha256: createHash("sha256").update(imageBytes).digest("hex"),
          expectedSizeBytes: imageBytes.length,
          contentType: IMAGE_TYPES[extension],
        })
      }
    }
    templates.push(template)
  }
  if (!templates.length)
    return {
      catalogueVersion,
      publishedAt,
      templates,
      objects: [],
      pointer: null,
    }
  const catalogueBytes = Buffer.from(
    JSON.stringify(
      { schemaVersion: 1, catalogueVersion, publishedAt, templates },
      null,
      2
    ) + "\n"
  )
  if (catalogueBytes.length > MAX_CATALOGUE_BYTES)
    fail({ message: "Project catalogue exceeds 1 MiB" })
  const catalogueKey = `catalogue/project/v1/releases/${catalogueVersion}.json`
  pendingObjects.push({
    key: catalogueKey,
    bytes: catalogueBytes,
    contentType: "application/json",
  })
  const objects = []
  for (const object of pendingObjects.sort((a, b) =>
    compare({ left: a.key, right: b.key })
  ))
    objects.push(await objectDescriptor({ outputPath, ...object }))
  const pointerBytes = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        catalogueVersion,
        sha256: createHash("sha256").update(catalogueBytes).digest("hex"),
      },
      null,
      2
    ) + "\n"
  )
  if (pointerBytes.length > 4096)
    fail({ message: "Project catalogue pointer exceeds 4096 bytes" })
  const pointer = await objectDescriptor({
    outputPath,
    key: "catalogue/project/v1/current.json",
    bytes: pointerBytes,
    contentType: "application/json",
    cacheControl: "no-cache",
  })
  return { catalogueVersion, publishedAt, templates, objects, pointer }
}

module.exports = { buildProjectCatalogue }
