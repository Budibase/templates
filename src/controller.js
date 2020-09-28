const fs = require("fs-extra");
const path = require("path");
const tar = require("tar");
const S3 = require("./s3");
const Worker = require("./worker");
const Template = require("./template");
const template = require("./template");

/**
 * Controller responsible for orchestrating template functions.
 */
module.exports = function () {
  const controller = this;
  controller.worker = new Worker(controller);
  controller.templates = [];
  controller.rootPath = path.join(__dirname, "..");
  controller.package = require(path.join(controller.rootPath, "package.json"));

  /**
   * Discovers available templates and parses them.
   * Must be called before building templates.
   */
  controller.discoverTemplates = controller.worker.do(() => {
    const templatesPath = path.join(controller.rootPath, "templates");
    const directories = fs.readdirSync(templatesPath);
    let templates = [];
    for (let templateType of directories) {
      const templateTypePath = path.join(templatesPath, templateType);
      const templatesForType = fs.readdirSync(templateTypePath);
      for (let directory of templatesForType) {
        try {
          const template = new Template(
            templateTypePath,
            directory,
            templateType
          );
          templates.push(template);
        } catch (error) {
          console.log(
            `Skipping template "${directory}" due to error: \n${error}`
          );
        }
      }
    }
    controller.templates = templates;
  });

  /**
   * Prints a list of all available templates and their versions.
   */
  controller.listTemplates = controller.worker.do(() => {
    console.log(`${controller.templates.length} template(s) found.`);
    controller.templates.forEach((template) => {
      console.log(template.getSummary());
    });
  });

  /**
   * Builds the manifest file of all available templates.
   */
  controller.buildManifest = controller.worker.do(() => {
    // Remove any old manifest
    const distPath = path.join(controller.rootPath, "dist");
    fs.ensureDirSync(distPath);
    const manifestPath = path.join(distPath, "manifest.json");
    fs.removeSync(manifestPath);

    // Write new manifest
    console.log(`Writing manifest to ${manifestPath}...`);
    try {
      let manifest = {};
      manifest.templates = {
        app: {},
        screen: {},
        component: {},
      };
      const templates = controller.templates.map((template) =>
        template.getManifestEntry()
      );
      for (let template of templates) {
        manifest.templates[template.type][template.name] = template;
      }
      fs.writeJsonSync(manifestPath, manifest, { spaces: "\t" });
    } catch (error) {
      console.log(`\nError building and writing manifest: \n${error}\n`);
    }
  });

  /**
   * Builds a compressed tar file of all available built templates.
   */
  controller.buildTar = controller.worker.do(() => {
    // Remove any old bundles
    const distTemplatesPath = path.join(
      controller.rootPath,
      "dist",
      "templates"
    );
    fs.removeSync(distTemplatesPath);
    fs.ensureDirSync(distTemplatesPath);

    // pack each template into a tar 
    for (let template of controller.templates) {
      // Create new tar file
      const tarOutputPath = path.join(distTemplatesPath, template.type)
      fs.ensureDirSync(tarOutputPath)

      console.log(`Writing tar bundle to ${tarOutputPath}...`);
      const cwd = path.join(controller.rootPath, "templates", template.type)
      tar.c(
        {
          gzip: true,
          file: path.join(tarOutputPath, `${template.name}.tar.gz`),
          sync: true,
          cwd,
        },
        [template.name]
      );
    }
  });

  /**
   * Publishes the manifest, tar file and individual built templates to a S3 bucket.
   * Individual templates are published under the path [templateType]/[templateName].
   */
  controller.publish = controller.worker.do(async () => {
    // Authenticate with AWS and ensure S3 bucket exists
    const s3 = new S3();
    await s3.init();
    await s3.ensureBucketExists();
    await s3.configureBucketPolicy();

    // Upload manifest and tar
    const manifestPath = path.join(
      controller.rootPath,
      "dist",
      "manifest.json"
    );
    if (fs.existsSync(manifestPath)) {
      await s3.upload(manifestPath, "manifest.json");
    }

    // Upload template tar files
    const distTemplatesPath = path.join(controller.rootPath, "dist", "templates");
    fs.ensureDirSync(distTemplatesPath);
    const templateTypes = fs.readdirSync(distTemplatesPath);

    const uploads = [];

    // for each file in the manifest
    // iterate, read and upload
    for (let type of templateTypes) {
      let templateBundlePath = path.join(distTemplatesPath, type);
      const templates = fs.readdirSync(templateBundlePath);
      for (let templateTar of templates) {
        try {
          const bundlePath = path.join(templateBundlePath, templateTar)
          const key = `templates/${type}/${templateTar}`;
          await s3.upload(bundlePath, key);
        } catch (error) {
          console.log(`Error uploading ${templateTar}:`);
          console.log(error);
        }
      }
    }
    await Promise.all(uploads);
  });
};
