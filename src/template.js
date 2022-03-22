const fs = require("fs-extra")
const path = require("path")
const constants = require("./constants")

/**
 * Image key resolution
 * 
 * @param templateName the name of the template
 * @param imageKey an optional key for the image
 */
const resolveImageKey = (templateName, imageKey) => {
  if(imageKey){
    return imageKey
  }
  let parsedTemplateName = templateName ? templateName.toLowerCase().trim() : "bb-template-thumbnail"
  return parsedTemplateName.replace(/\s+/g, "-")
}

/**
 * Individual parsed template.
 *
 * @param rootPath the absolute path to where templates are listed
 * @param name the name of this template
 */
module.exports = function (rootPath, name, type) {
  const template = this
  template.rootPath = rootPath
  template.type = type
  template.name = name
  template.path = path.join(rootPath, name)
  const definitionPath = path.join(template.path, "definition.json")
  template.definition = require(definitionPath)

  /**
   * Builds the structure used inside the manifest for this template.
   * This consists of the name, type, and template definition JSON.
   *
   * @returns {object} the manifest entry
   */
  template.getManifestEntry = () => {
    const { category, name, description, image, icon, background, url } = template.definition
    
    const imageKey = resolveImageKey(name, image)

    return {
      background,
      icon,
      category,
      description,
      name,
      url,
      type: template.type,
      key: `${template.type}/${template.name}`,
      image: `https://${constants.AWS_S3_BUCKET_NAME}.s3.${constants.AWS_REGION}.amazonaws.com/${imageKey}`
    }
  }
}
