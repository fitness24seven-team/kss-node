'use strict';

/**
 * The `kss/builder/base/twig` module loads the KssBuilderBaseTwig
 * class, a `{@link KssBuilderBase}` sub-class using Twig.js templating.
 * ```
 * const KssBuilderBaseTwig = require('kss/builder/base/twig');
 * ```
 * @module kss/builder/base/twig
 */

const KssBuilderBase = require('../kss_builder_base.js'),
  marked = require('marked'),
  path = require('path'),
  Promise = require('bluebird');

const fs = Promise.promisifyAll(require('fs-extra')),
  glob = Promise.promisify(require('glob'));

/**
 * A kss-node builder takes input files and builds a style guide using
 * Twig.js templates.
 */
class KssBuilderBaseTwig extends KssBuilderBase {

  /**
   * Create a KssBuilderBaseTwig object.
   *
   * ```
   * const KssBuilderBaseTwig = require('kss/builder/base/twig');
   * const builder = new KssBuilderBaseTwig();
   * ```
   */
  constructor() {
    super();

    // Store the version of the builder API that the builder instance is
    // expecting; we will verify this in loadBuilder().
    this.API = '3.0';

    // Tell kss-node which Yargs-like options this builder has.
    this.addOptionDefinitions({
      'extend': {
        group: 'Style guide:',
        string: true,
        path: true,
        describe: 'Location of modules to extend Twig.js; see http://bit.ly/kss-wiki'
      },
      'extend-drupal8': {
        group: 'Style guide:',
        boolean: true,
        default: false,
        multiple: false,
        describe: 'Extend Twig.js using kss\'s Drupal 8 extensions'
      },
      'namespace': {
        group: 'Style guide:',
        string: true,
        describe: 'Adds a Twig namespace, given the formatted string: "namespace:path"'
      },
      'homepage': {
        group: 'Style guide:',
        string: true,
        multiple: false,
        describe: 'File name of the homepage\'s Markdown file',
        default: 'homepage.md'
      },
      'placeholder': {
        group: 'Style guide:',
        string: true,
        multiple: false,
        describe: 'Placeholder text to use for modifier classes',
        default: '[modifier class]'
      }
    });
  }

  /**
   * Allow the builder to preform pre-build tasks or modify the KssStyleGuide
   * object.
   *
   * The method can be set by any KssBuilderBase sub-class to do any custom
   * tasks after the KssStyleGuide object is created and before the HTML style
   * guide is built.
   *
   * @param {KssStyleGuide} styleGuide The KSS style guide in object format.
   * @returns {Promise.<null>} A `Promise` object resolving to `null`.
   */
  prepare(styleGuide) {
    return super.prepare(styleGuide).then(styleGuide => {
      // Store the global Twig object.
      this.Twig = require('twig');

      // We need the ability to reset the template registry since the global
      // Twig object is the same object every time it is require()d.
      this.Twig.registryReset = (function() {
        this.extend(function(Twig) {
          Twig.Templates.registry = {};
        });
      }).bind(this.Twig);

      // Collect the namespaces to be used by Twig.
      this.namespaces = {
        builderTwig: path.resolve(this.options.builder)
      };
      this.options.namespace.forEach(namespace => {
        // namespace should be of the form "namespace:path";
        let tokens = namespace.split(':', 2);
        if (tokens[1]) {
          this.namespaces[tokens[0]] = path.resolve(tokens[1]);
        }
      });

      // Promisify Twig.twig().
      let namespacesFromKSS = this.namespaces;
      this.Twig.twigAsync = (function(options) {
        return new Promise((resolve, reject) => {
          // Use our Promise's functions.
          options.load = resolve;
          options.error = reject;
          // We enforce some options.
          options.async = true;
          options.autoescape = true;
          options.namespaces = namespacesFromKSS;

          // twig() ignores load/error if data or ref are specified.
          if (options.data || options.ref) {
            try {
              resolve(this.twig(options));
            } catch (error) {
              // istanbul ignore next
              reject(error);
            }
          } else {
            // In 0.10.2 and earlier, twig.js incorrectly "throws" an error if
            // the path is not a valid file. So we have to double check for an
            // error and use reject() before calling twig().
            // @TODO Remove after upstream fix. https://github.com/twigjs/twig.js/pull/431
            fs.stat(options.path, (err, stats) => {
              if (err || !stats.isFile()) {
                reject(new Error('Unable to find template file ' + options.path));
                return;
              }
              // Call twig() with our load/error callbacks.
              this.twig(options);
            });
          }
        });
      }).bind(this.Twig);

      let safeMarkup;
      this.Twig.extend(Twig => {
        safeMarkup = function(input) {
          if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
            return Twig.Markup(input);
          } else if (Array.isArray(input)) {
            return input.map(safeMarkup);
          } else if (input && typeof input === 'object') {
            for (let key in input) {
              // istanbul ignore else
              if (input.hasOwnProperty(key)) {
                input[key] = safeMarkup(input[key]);
              }
            }
            return input;
          }
          return input;
        };
      });
      this.safeMarkup = safeMarkup;

      if (this.options.verbose) {
        this.log('');
        this.log('Building your KSS style guide!');
        this.log('');
        this.log(' * KSS Source  : ' + this.options.source.join(', '));
        this.log(' * Destination : ' + this.options.destination);
        this.log(' * Builder     : ' + this.options.builder);
        if (this.options.extend.length) {
          this.log(' * Extend      : ' + this.options.extend.join(', '));
        }
        if (this.options.namespace.length) {
          this.log(' * Namespace   : ' + this.options.namespace.join(', '));
        }
        this.log('');
      }

      let prepTasks = [];

      // Create a new destination directory.
      prepTasks.push(
        fs.mkdirsAsync(this.options.destination).then(() => {
          // Optionally, copy the contents of the builder's "kss-assets" folder.
          return fs.copyAsync(
            path.join(this.options.builder, 'kss-assets'),
            path.join(this.options.destination, 'kss-assets'),
            {
              clobber: true,
              filter: filePath => {
                // Only look at the part of the path inside the builder.
                let relativePath = path.sep + path.relative(this.options.builder, filePath);
                // Skip any files with a path matching: /node_modules or /.
                return (new RegExp('^(?!.*\\' + path.sep + '(node_modules$|\\.))')).test(relativePath);
              }
            }
          ).catch(() => {
            // If the builder does not have a kss-assets folder, ignore the error.
            // istanbul ignore next
            return Promise.resolve();
          });
        })
      );

      // Load modules that extend Twig.
      if (this.options['extend-drupal8']) {
        this.options.extend.unshift(path.resolve(__dirname, 'extend-drupal8'));
      }
      this.options.extend.forEach(directory => {
        prepTasks.push(
          fs.readdirAsync(directory).then(files => {
            files.forEach(fileName => {
              if (path.extname(fileName) === '.js') {
                let extendFunction = require(path.join(directory, fileName));
                // istanbul ignore else
                if (typeof extendFunction === 'function') {
                  extendFunction(this.Twig, this.options);
                }
              }
            });
          })
        );
      });

      return Promise.all(prepTasks).then(() => {
        return Promise.resolve(styleGuide);
      });
    });
  }

  /**
   * Build the HTML files of the style guide given a KssStyleGuide object.
   *
   * @param {KssStyleGuide} styleGuide The KSS style guide in object format.
   * @returns {Promise.<KssStyleGuide>} A `Promise` object resolving to a
   *   `KssStyleGuide` object.
   */
  build(styleGuide) {
    this.styleGuide = styleGuide;
    this.userTemplates = {};

    // istanbul ignore else
    if (typeof this.templates === 'undefined') {
      this.templates = {};
    }

    // Reset the Twig template registry so KSS can be run in a "watch" task that
    // does not destroy the Node.js environment between builds.
    this.Twig.registryReset();

    let buildTasks = [],
      loadTask;

    // Optionally load the index.twig Twig template.
    // istanbul ignore else
    if (typeof this.templates.index === 'undefined') {
      loadTask = this.Twig.twigAsync({
        id: '@builderTwig/index.twig',
        path: path.resolve(this.options.builder, 'index.twig')
      }).then(template => {
        this.templates.index = template;
        return Promise.resolve();
      });
    } else {
      loadTask = Promise.resolve();
    }

    // Optionally load the section.twig Twig template.
    // istanbul ignore else
    if (typeof this.templates.section === 'undefined') {
      loadTask = loadTask.then(() => {
        return this.Twig.twigAsync({
          id: '@builderTwig/section.twig',
          path: path.resolve(this.options.builder, 'section.twig')
        }).then(template => {
          /* istanbul ignore next */
          this.templates.section = template;
          /* istanbul ignore next */
          return Promise.resolve();
        }).catch(() => {
          // If the section.twig template cannot be read, use index.twig.
          this.templates.section = this.templates.index;
          return Promise.resolve();
        });
      });
    }

    // Optionally load the item.twig Twig template.
    // istanbul ignore else
    if (typeof this.templates.item === 'undefined') {
      loadTask = loadTask.then(() => {
        return this.Twig.twigAsync({
          id: '@builderTwig/item.twig',
          path: path.resolve(this.options.builder, 'item.twig')
        }).then(template => {
          /* istanbul ignore next */
          this.templates.item = template;
          /* istanbul ignore next */
          return Promise.resolve();
        }).catch(() => {
          // If the item.twig template cannot be read, use section.twig or index.twig.
          this.templates.item = this.templates.section ? this.templates.section : /* istanbul ignore next */ this.templates.index;
          return Promise.resolve();
        });
      });
    }
    buildTasks.push(loadTask);

    let sections = this.styleGuide.sections();

    if (this.options.verbose && this.styleGuide.meta.files) {
      this.log(this.styleGuide.meta.files.map(file => {
        return ' - ' + file;
      }).join('\n'));
    }

    if (this.options.verbose) {
      this.log('...Determining section markup:');
    }

    let sectionRoots = [];

    // Compile an inline template in markup.
    let compileInline = template => {
      return this.Twig.twigAsync({
        id: template.name,
        data: template.markup
      }).then(() => {
        return template;
      });
    };

    // Save the name of the template and its context for retrieval in
    // buildPage(), where we only know the reference.
    let saveTemplate = template => {
      this.userTemplates[template.reference] = {
        ref: template.name,
        context: template.context,
        exampleRef: template.exampleFile ? template.exampleName : false,
        exampleContext: template.exampleContext
      };

      return Promise.resolve();
    };

    sections.forEach(section => {
      // Accumulate an array of section references for all sections at the root
      // of the style guide.
      let currentRoot = section.reference().split(/(?:\.|\ \-\ )/)[0];
      if (sectionRoots.indexOf(currentRoot) === -1) {
        sectionRoots.push(currentRoot);
      }

      if (!section.markup()) {
        return;
      }

      // Register all the markup blocks as Twig templates.
      let template = {
        name: section.reference(),
        reference: section.reference(),
        file: '',
        markup: section.markup(),
        context: {},
        exampleName: false,
        exampleFile: '',
        exampleContext: {}
      };

      // Check if the markup is a file path.
      if (!template.markup.match(/^[^\n]+\.twig$/)) {
        // istanbul ignore else
        if (this.options.verbose) {
          this.log(' - ' + template.reference + ': inline markup');
        }
        buildTasks.push(
          compileInline(template).then(saveTemplate)
        );
      } else {
        // Attempt to load the file path.
        section.custom('markupFile', template.markup);
        template.file = template.markup;
        template.name = path.basename(template.file);
        template.exampleName = 'kss-example-' + template.name;

        let findTemplates = [];
        this.options.source.forEach(source => {
          findTemplates.push(glob(source + '/**/' + template.file));
          findTemplates.push(glob(source + '/**/kss-example-' + template.name));
        });
        buildTasks.push(
          Promise.all(findTemplates).then(globMatches => {
            let foundTemplate = false,
              foundExample = false,
              compileTemplates = [];
            for (let files of globMatches) {
              if (!foundTemplate || !foundExample) {
                for (let file of files) {
                  // Read the template from the first matched path.
                  let filename = path.basename(file);
                  if (!foundTemplate && filename === template.name) {
                    foundTemplate = true;
                    template.file = file;
                    compileTemplates.push(
                      this.Twig.twigAsync({
                        id: template.name,
                        path: file
                      }).then(() => {
                        // Load sample context for the template from the sample
                        // .json file.
                        try {
                          template.context = require(path.join(path.dirname(template.file), path.basename(template.name, '.twig') + '.json'));
                        } catch (error) {
                          template.context = {};
                        }
                        return Promise.resolve();
                      })
                    );
                  } else if (!foundExample && filename === template.exampleName) {
                    foundExample = true;
                    template.exampleFile = file;
                    compileTemplates.push(
                      this.Twig.twigAsync({
                        id: template.exampleName,
                        path: file
                      }).then(() => {
                        // Load sample context for the template from the sample
                        // .json file.
                        try {
                          template.exampleContext = require(path.join(path.dirname(template.exampleFile), path.basename(template.exampleName, '.twig') + '.json'));
                        } catch (error) {
                          // istanbul ignore next
                          template.exampleContext = {};
                        }
                        return Promise.resolve();
                      })
                    );
                  }
                }
              }
            }

            // If the markup file is not found, note that in the style guide.
            if (!foundTemplate && !foundExample) {
              template.markup += ' NOT FOUND!';
              if (!this.options.verbose) {
                this.log('WARNING: In section ' + template.reference + ', ' + template.markup);
              }
              compileTemplates.push(
                compileInline(template)
              );
            } else /* istanbul ignore if */ if (!foundTemplate) {
              // If we found an example, but no template, compile an empty
              // template.
              compileTemplates.push(
                this.Twig.twigAsync({
                  id: template.name,
                  data: '{# Cannot be an empty string. #}'
                })
              );
            }

            if (this.options.verbose) {
              this.log(' - ' + template.reference + ': ' + template.markup);
            }

            return Promise.all(compileTemplates).then(() => {
              return template;
            });
          }).then(saveTemplate)
        );
      }
    });

    return Promise.all(buildTasks).then(() => {
      if (this.options.verbose) {
        this.log('...Building style guide pages:');
      }

      let buildPageTasks = [];

      // Build the homepage.
      buildPageTasks.push(this.buildPage('index', null, []));

      // Group all of the sections by their root reference, and make a page for
      // each.
      sectionRoots.forEach(rootReference => {
        buildPageTasks.push(this.buildPage('section', rootReference, this.styleGuide.sections(rootReference + '.*')));
      });

      // For each section, build a page which only has a single section on it.
      // istanbul ignore else
      if (this.templates.item) {
        sections.forEach(section => {
          buildPageTasks.push(this.buildPage('item', section.reference(), [section]));
        });
      }

      return Promise.all(buildPageTasks);
    }).then(() => {
      // We return the KssStyleGuide, just like KssBuilderBase.build() does.
      return Promise.resolve(styleGuide);
    });
  }

  /**
   * Renders the Twig template for a section and saves it to a file.
   *
   * @param {string} templateName The name of the template to use.
   * @param {string|null} pageReference The reference of the current page's root
   *   section, or null if the current page is the homepage.
   * @param {Array} sections An array of KssSection objects.
   * @param {Object} [context] Additional context to give to the Twig template
   *   when it is rendered.
   * @returns {Promise} A `Promise` object.
   */
  buildPage(templateName, pageReference, sections, context) {
    context = context || {};
    context.template = {
      isHomepage: templateName === 'index',
      isSection: templateName === 'section',
      isItem: templateName === 'item'
    };
    context.styleGuide = this.styleGuide;
    context.sections = sections.map(section => {
      return section.toJSON();
    });
    context.hasNumericReferences = this.styleGuide.hasNumericReferences();
    context.userTemplates = this.userTemplates;
    context.options = this.options || /* istanbul ignore next */ {};

    // Render the template for each section markup and modifier.
    return Promise.all(
      context.sections.map(section => {
        if (section.markup) {
          // Load the information about this section's markup template.
          let templateInfo = this.userTemplates[section.reference];
          return this.Twig.twigAsync({
            ref: templateInfo.ref
          }).then(template => {
            // Copy the template.context so we can modify it.
            let data = JSON.parse(JSON.stringify(templateInfo.context));

            /* eslint-disable camelcase */

            // Display the placeholder if the section has modifiers.
            data.modifier_class = data.modifier_class || '';
            if (section.modifiers.length !== 0 && this.options.placeholder) {
              data.modifier_class += (data.modifier_class ? ' ' : '') + this.options.placeholder;
            }

            section.markup = template.render(this.safeMarkup(data));
            section.example = section.markup;

            let getExampleTemplate,
              templateContext;
            if (templateInfo.exampleRef) {
              getExampleTemplate = this.Twig.twigAsync({
                ref: templateInfo.exampleRef
              });
              templateContext = templateInfo.exampleContext;
            } else {
              getExampleTemplate = Promise.resolve(template);
              templateContext = templateInfo.context;
            }

            /* eslint-disable max-nested-callbacks */
            return getExampleTemplate.then(template => {
              if (templateInfo.exampleRef) {
                let data = JSON.parse(JSON.stringify(templateContext));
                data.modifier_class = data.modifier_class || /* istanbul ignore next */ '';
                // istanbul ignore else
                if (section.modifiers.length !== 0 && this.options.placeholder) {
                  data.modifier_class += (data.modifier_class ? ' ' : /* istanbul ignore next */ '') + this.options.placeholder;
                }
                section.example = template.render(this.safeMarkup(data));
              }
              section.modifiers.forEach(modifier => {
                let data = JSON.parse(JSON.stringify(templateContext));
                data.modifier_class = (data.modifier_class ? data.modifier_class + ' ' : '') + modifier.className;
                modifier.markup = template.render(this.safeMarkup(data));
              });
              return Promise.resolve();
            });
            /* eslint-enable camelcase, max-nested-callbacks */
          });
        } else {
          return Promise.resolve();
        }
      })
    ).then(() => {

      // Create the HTML to load the optional CSS and JS (if a sub-class hasn't already built it.)
      // istanbul ignore else
      if (typeof context.styles === 'undefined') {
        context.styles = '';
        for (let key in this.options.css) {
          // istanbul ignore else
          if (this.options.css.hasOwnProperty(key)) {
            context.styles = context.styles + '<link rel="stylesheet" href="' + this.options.css[key] + '">\n';
          }
        }
      }
      // istanbul ignore else
      if (typeof context.scripts === 'undefined') {
        context.scripts = '';
        for (let key in this.options.js) {
          // istanbul ignore else
          if (this.options.js.hasOwnProperty(key)) {
            context.scripts = context.scripts + '<script src="' + this.options.js[key] + '"></script>\n';
          }
        }
      }

      // Create a menu for the page (if a sub-class hasn't already built one.)
      // istanbul ignore else
      if (typeof context.menu === 'undefined') {
        context.menu = this.createMenu(pageReference);
      }

      // Determine the file name to use for this page.
      if (pageReference) {
        let rootSection = this.styleGuide.sections(pageReference);
        if (this.options.verbose) {
          this.log(
            ' - ' + templateName + ' ' + pageReference
            + ' ['
            + (rootSection.header() ? rootSection.header() : /* istanbul ignore next */ 'Unnamed')
            + ']'
          );
        }
        // Convert the pageReference to be URI-friendly.
        pageReference = rootSection.referenceURI();
      } else if (this.options.verbose) {
        this.log(' - homepage');
      }
      let fileName = templateName + (pageReference ? '-' + pageReference : '') + '.html';

      let getHomepageText;
      if (templateName !== 'index') {
        getHomepageText = Promise.resolve();
        context.homepage = false;
      } else {
        // Grab the homepage text if it hasn't already been provided.
        getHomepageText = (typeof context.homepage !== 'undefined') ? /* istanbul ignore next */ Promise.resolve() : Promise.all(
          this.options.source.map(source => {
            return glob(source + '/**/' + this.options.homepage);
          })
        ).then(globMatches => {
          for (let files of globMatches) {
            if (files.length) {
              // Read the file contents from the first matched path.
              return fs.readFileAsync(files[0], 'utf8');
            }
          }

          if (this.options.verbose) {
            this.log('   ...no homepage content found in ' + this.options.homepage + '.');
          } else {
            this.log('WARNING: no homepage content found in ' + this.options.homepage + '.');
          }
          return '';
        }).then(homePageText => {
          // Ensure homePageText is a non-false value. And run any results through
          // Markdown.
          context.homepage = homePageText ? marked(homePageText) : '';
          return Promise.resolve();
        });
      }

      return getHomepageText.then(() => {
        // Render the template and save it to the destination.
        return fs.writeFileAsync(
          path.join(this.options.destination, fileName),
          this.templates[templateName].render(context)
        );
      });
    });
  }
}

module.exports = KssBuilderBaseTwig;
