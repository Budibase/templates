const { createHash } = require("node:crypto")
const { createReadStream } = require("node:fs")
const {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3")

const immutableCacheControl = "public,max-age=31536000,immutable"
const pointerKey = "catalogue/project/v1/current.json"
const archiveKeyPattern = /^artifacts\/project\/[a-z0-9]+(?:-[a-z0-9]+)*\/[0-9]+\.[0-9]+\.[0-9]+\/project\.tar\.gz$/
const imageKeyPattern = /^artifacts\/project\/[a-z0-9]+(?:-[a-z0-9]+)*\/[0-9]+\.[0-9]+\.[0-9]+\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp)$/
const releaseKeyPattern = /^catalogue\/project\/v1\/releases\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/
const publicFetchTimeoutMs = 15000

const readRepositoryUrl = ({ repositoryUrl }) => {
  let url
  try {
    url = new URL(repositoryUrl)
  } catch {
    throw new Error(
      "Project publication requires a public HTTPS repository origin"
    )
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Project publication requires a public HTTPS repository origin"
    )
  }
  return url
}

const getContentType = ({ key, pointer }) => {
  if (pointer) {
    return key === pointerKey ? "application/json" : undefined
  }
  if (archiveKeyPattern.test(key)) {
    return "application/gzip"
  }
  if (releaseKeyPattern.test(key)) {
    return "application/json"
  }
  const image = key.match(imageKeyPattern)
  if (image) {
    const extension = image[1]
    return `image/${extension === "jpg" ? "jpeg" : extension}`
  }
}

const readVerifiedFile = async ({ object, retainBody = false }) => {
  const hash = createHash("sha256")
  const body = retainBody ? Buffer.alloc(object.sizeBytes) : undefined
  let sizeBytes = 0
  for await (const chunk of createReadStream(object.path)) {
    const nextSize = sizeBytes + chunk.length
    if (nextSize > object.sizeBytes) {
      throw new Error(`Project publication file changed: ${object.key}`)
    }
    hash.update(chunk)
    if (body) {
      chunk.copy(body, sizeBytes)
    }
    sizeBytes = nextSize
  }
  if (sizeBytes !== object.sizeBytes || hash.digest("hex") !== object.sha256) {
    throw new Error(`Project publication file changed: ${object.key}`)
  }
  return body
}

const validatePublicationObject = async ({ object, pointer = false }) => {
  const contentType = getContentType({ key: object.key, pointer })
  const cacheControl = pointer ? "no-cache" : immutableCacheControl
  if (!contentType) {
    throw new Error(`Invalid Project publication key: ${object.key}`)
  }
  if (
    object.contentType !== contentType ||
    object.cacheControl !== cacheControl
  ) {
    throw new Error(`Invalid Project publication metadata: ${object.key}`)
  }
  await readVerifiedFile({ object })
  return { ...object }
}

const isMissingObject = (error) =>
  error.name === "NoSuchKey" ||
  (error.name === "NotFound" && error.$metadata?.httpStatusCode === 404)

const isConditionalConflict = (error) =>
  error.name === "PreconditionFailed" ||
  error.name === "ConditionalRequestConflict" ||
  error.$metadata?.httpStatusCode === 412 ||
  error.$metadata?.httpStatusCode === 409

const verifyRemoteObject = async ({ client, bucket, object }) => {
  let response
  try {
    response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: object.key })
    )
  } catch (error) {
    if (isMissingObject(error)) {
      return false
    }
    throw error
  }
  if (!response.Body) {
    throw new Error(`Project publication object has no body: ${object.key}`)
  }
  const hash = createHash("sha256")
  let sizeBytes = 0
  for await (const chunk of response.Body) {
    sizeBytes += chunk.length
    if (sizeBytes > object.sizeBytes) {
      throw new Error(`Immutable Project publication collision: ${object.key}`)
    }
    hash.update(chunk)
  }
  if (sizeBytes !== object.sizeBytes || hash.digest("hex") !== object.sha256) {
    throw new Error(`Immutable Project publication collision: ${object.key}`)
  }
  return true
}

const verifyPublicObject = async ({ fetch, repositoryUrl, object }) => {
  const abortController = new AbortController()
  const timeout = setTimeout(
    () => abortController.abort(),
    publicFetchTimeoutMs
  )
  timeout.unref()
  try {
    const response = await fetch(new URL(object.key, repositoryUrl), {
      redirect: "error",
      credentials: "omit",
      headers: { "Accept-Encoding": "identity" },
      signal: abortController.signal,
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`Public object is unavailable (HTTP ${response.status})`)
    }
    const hash = createHash("sha256")
    let sizeBytes = 0
    for await (const chunk of response.body) {
      sizeBytes += chunk.length
      if (sizeBytes > object.sizeBytes) {
        throw new Error("Public object exceeds its declared size")
      }
      hash.update(chunk)
    }
    if (
      sizeBytes !== object.sizeBytes ||
      hash.digest("hex") !== object.sha256
    ) {
      throw new Error(
        "Public object does not match its declared size or checksum"
      )
    }
  } catch (error) {
    throw new Error(
      `Unable to verify public Project publication object ${object.key}: ${error.message}`,
      { cause: error }
    )
  } finally {
    clearTimeout(timeout)
  }
}

const putObject = async ({ client, bucket, object, immutable }) => {
  const body = await readVerifiedFile({ object, retainBody: true })
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: object.key,
      Body: body,
      ContentType: object.contentType,
      CacheControl: object.cacheControl,
      ChecksumSHA256: Buffer.from(object.sha256, "hex").toString("base64"),
      ...(immutable && { IfNoneMatch: "*" }),
    })
  )
}

const publishProjectCatalogue = async ({
  publication,
  bucket,
  region,
  client,
  fetch = globalThis.fetch,
}) => {
  if (publication.pointer === null && publication.objects.length === 0) {
    return {
      skipped: true,
      uploadedKeys: [],
      reusedKeys: [],
      pointerKey: null,
    }
  }
  if (!bucket || !region || !publication.pointer) {
    throw new Error("Project publication requires a bucket, region and pointer")
  }
  const repositoryUrl = readRepositoryUrl({
    repositoryUrl: publication.repositoryUrl,
  })
  const keys = publication.objects.map((object) => object.key)
  if (new Set(keys).size !== keys.length) {
    throw new Error("Project publication contains duplicate object keys")
  }
  const objects = []
  for (const object of publication.objects) {
    objects.push(await validatePublicationObject({ object }))
  }
  const pointer = await validatePublicationObject({
    object: publication.pointer,
    pointer: true,
  })
  const releases = objects.filter((object) =>
    releaseKeyPattern.test(object.key)
  )
  if (
    releases.length !== 1 ||
    !objects.some((object) => archiveKeyPattern.test(object.key))
  ) {
    throw new Error(
      "Project publication requires one release and Project archives"
    )
  }
  const pointerBody = await readVerifiedFile({
    object: pointer,
    retainBody: true,
  })
  const pointerValue = JSON.parse(pointerBody.toString("utf8"))
  if (
    pointerValue.schemaVersion !== 1 ||
    pointerValue.catalogueVersion !== publication.catalogueVersion ||
    pointerValue.sha256 !== releases[0].sha256 ||
    releases[0].key !==
      `catalogue/project/v1/releases/${publication.catalogueVersion}.json`
  ) {
    throw new Error("Project publication pointer does not match its release")
  }
  const s3 = client || new S3Client({ region })
  const uploadedKeys = []
  const reusedKeys = []

  try {
    const existing = await Promise.all(
      objects.map((object) =>
        verifyRemoteObject({ client: s3, bucket, object })
      )
    )
    for (const [index, object] of objects.entries()) {
      if (existing[index]) {
        reusedKeys.push(object.key)
        continue
      }
      try {
        await putObject({ client: s3, bucket, object, immutable: true })
      } catch (error) {
        if (!isConditionalConflict(error)) {
          throw error
        }
        if (!(await verifyRemoteObject({ client: s3, bucket, object }))) {
          throw new Error(
            `Project publication object missing after a write conflict: ${object.key}`
          )
        }
        reusedKeys.push(object.key)
        continue
      }
      if (!(await verifyRemoteObject({ client: s3, bucket, object }))) {
        throw new Error(`Project publication upload is missing: ${object.key}`)
      }
      uploadedKeys.push(object.key)
    }
    for (const object of objects) {
      await verifyPublicObject({ fetch, repositoryUrl, object })
    }
    await putObject({ client: s3, bucket, object: pointer, immutable: false })
    return {
      skipped: false,
      uploadedKeys,
      reusedKeys,
      pointerKey: pointer.key,
    }
  } finally {
    if (!client) {
      s3.destroy()
    }
  }
}

module.exports = { publishProjectCatalogue }
