/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactNativeAttributePayload
 * @flow
 */
'use strict';

var ReactNativePropRegistry = require('ReactNativePropRegistry');

var deepDiffer = require('deepDiffer');
var flattenStyle = require('flattenStyle');

var emptyObject = {};

/**
 * Create a payload that contains all the updates between two sets of props.
 *
 * These helpers are all encapsulated into a single module, because they use
 * mutation as a performance optimization which leads to subtle shared
 * dependencies between the code paths. To avoid this mutable state leaking
 * across modules, I've kept them isolated to this module.
 */

type AttributeDiffer = (prevProp: mixed, nextProp: mixed) => boolean;
type AttributePreprocessor = (nextProp: mixed) => mixed;

type CustomAttributeConfiguration =
  // $FlowFixMe(>=0.34.0)
  { diff: AttributeDiffer, process: AttributePreprocessor } |
  // $FlowFixMe(>=0.34.0)
  { diff: AttributeDiffer } |
  // $FlowFixMe(>=0.34.0)
  { process: AttributePreprocessor };

type AttributeConfiguration =
  { [key: string]: (
    CustomAttributeConfiguration | AttributeConfiguration /*| boolean*/
  ) };

type NestedNode = Array<NestedNode> | Object | number;

// Tracks removed keys
var removedKeys = null;
var removedKeyCount = 0;

function defaultDiffer(prevProp: mixed, nextProp: mixed) : boolean {
  if (typeof nextProp !== 'object' || nextProp === null) {
    // Scalars have already been checked for equality
    return true;
  } else {
    // For objects and arrays, the default diffing algorithm is a deep compare
    return deepDiffer(prevProp, nextProp);
  }
}

function resolveObject(idOrObject: number | Object) : Object {
  if (typeof idOrObject === 'number') {
    return ReactNativePropRegistry.getByID(idOrObject);
  }
  return idOrObject;
}

function restoreDeletedValuesInNestedArray(
  updatePayload: Object,
  node: NestedNode,
  validAttributes: AttributeConfiguration
) {
  if (Array.isArray(node)) {
    var i = node.length;
    while (i-- && removedKeyCount > 0) {
      restoreDeletedValuesInNestedArray(
        updatePayload,
        node[i],
        validAttributes
      );
    }
  } else if (node && removedKeyCount > 0) {
    var obj = resolveObject(node);
    for (var propKey in removedKeys) {
      if (!removedKeys[propKey]) {
        continue;
      }
      var nextProp = obj[propKey];
      if (nextProp === undefined) {
        continue;
      }

      var attributeConfig = validAttributes[propKey];
      if (!attributeConfig) {
        continue; // not a valid native prop
      }

      if (typeof nextProp === 'function') {
        nextProp = true;
      }
      if (typeof nextProp === 'undefined') {
        nextProp = null;
      }

      if (typeof attributeConfig !== 'object') {
        // case: !Object is the default case
        updatePayload[propKey] = nextProp;
      } else if (typeof attributeConfig.diff === 'function' ||
                 typeof attributeConfig.process === 'function') {
        // case: CustomAttributeConfiguration
        var nextValue = typeof attributeConfig.process === 'function' ?
                        attributeConfig.process(nextProp) :
                        nextProp;
        updatePayload[propKey] = nextValue;
      }
      removedKeys[propKey] = false;
      removedKeyCount--;
    }
  }
}

function diffNestedArrayProperty(
  updatePayload:? Object,
  prevArray: Array<NestedNode>,
  nextArray: Array<NestedNode>,
  validAttributes: AttributeConfiguration
) : ?Object {
  var minLength = prevArray.length < nextArray.length ?
                  prevArray.length :
                  nextArray.length;
  var i;
  for (i = 0; i < minLength; i++) {
    // Diff any items in the array in the forward direction. Repeated keys
    // will be overwritten by later values.
    updatePayload = diffNestedProperty(
      updatePayload,
      prevArray[i],
      nextArray[i],
      validAttributes
    );
  }
  for (; i < prevArray.length; i++) {
    // Clear out all remaining properties.
    updatePayload = clearNestedProperty(
      updatePayload,
      prevArray[i],
      validAttributes
    );
  }
  for (; i < nextArray.length; i++) {
    // Add all remaining properties.
    updatePayload = addNestedProperty(
      updatePayload,
      nextArray[i],
      validAttributes
    );
  }
  return updatePayload;
}

function diffNestedProperty(
  updatePayload:? Object,
  prevProp: NestedNode,
  nextProp: NestedNode,
  validAttributes: AttributeConfiguration
) : ?Object {

  if (!updatePayload && prevProp === nextProp) {
    // If no properties have been added, then we can bail out quickly on object
    // equality.
    return updatePayload;
  }

  if (!prevProp || !nextProp) {
    if (nextProp) {
      return addNestedProperty(
        updatePayload,
        nextProp,
        validAttributes
      );
    }
    if (prevProp) {
      return clearNestedProperty(
        updatePayload,
        prevProp,
        validAttributes
      );
    }
    return updatePayload;
  }

  if (!Array.isArray(prevProp) && !Array.isArray(nextProp)) {
    // Both are leaves, we can diff the leaves.
    return diffProperties(
      updatePayload,
      resolveObject(prevProp),
      resolveObject(nextProp),
      validAttributes
    );
  }

  if (Array.isArray(prevProp) && Array.isArray(nextProp)) {
    // Both are arrays, we can diff the arrays.
    return diffNestedArrayProperty(
      updatePayload,
      prevProp,
      nextProp,
      validAttributes
    );
  }

  if (Array.isArray(prevProp)) {
    return diffProperties(
      updatePayload,
      // $FlowFixMe - We know that this is always an object when the input is.
      flattenStyle(prevProp),
      // $FlowFixMe - We know that this isn't an array because of above flow.
      resolveObject(nextProp),
      validAttributes
    );
  }

  return diffProperties(
    updatePayload,
    resolveObject(prevProp),
      // $FlowFixMe - We know that this is always an object when the input is.
    flattenStyle(nextProp),
    validAttributes
  );
}

/**
 * addNestedProperty takes a single set of props and valid attribute
 * attribute configurations. It processes each prop and adds it to the
 * updatePayload.
 */
function addNestedProperty(
  updatePayload:? Object,
  nextProp: NestedNode,
  validAttributes: AttributeConfiguration
) {
  if (!nextProp) {
    return updatePayload;
  }

  if (!Array.isArray(nextProp)) {
    // Add each property of the leaf.
    return addProperties(
      updatePayload,
      resolveObject(nextProp),
      validAttributes
    );
  }

  for (var i = 0; i < nextProp.length; i++) {
    // Add all the properties of the array.
    updatePayload = addNestedProperty(
      updatePayload,
      nextProp[i],
      validAttributes
    );
  }

  return updatePayload;
}

/**
 * clearNestedProperty takes a single set of props and valid attributes. It
 * adds a null sentinel to the updatePayload, for each prop key.
 */
function clearNestedProperty(
  updatePayload:? Object,
  prevProp: NestedNode,
  validAttributes: AttributeConfiguration
) : ?Object {
  if (!prevProp) {
    return updatePayload;
  }

  if (!Array.isArray(prevProp)) {
    // Add each property of the leaf.
    return clearProperties(
      updatePayload,
      resolveObject(prevProp),
      validAttributes
    );
  }

  for (var i = 0; i < prevProp.length; i++) {
    // Add all the properties of the array.
    updatePayload = clearNestedProperty(
      updatePayload,
      prevProp[i],
      validAttributes
    );
  }
  return updatePayload;
}

/**
 * diffProperties takes two sets of props and a set of valid attributes
 * and write to updatePayload the values that changed or were deleted.
 * If no updatePayload is provided, a new one is created and returned if
 * anything changed.
 */
function diffProperties(
  updatePayload: ?Object,
  prevProps: Object,
  nextProps: Object,
  validAttributes: AttributeConfiguration
): ?Object {
  var attributeConfig : ?(CustomAttributeConfiguration | AttributeConfiguration);
  var nextProp;
  var prevProp;

  for (var propKey in nextProps) {
    attributeConfig = validAttributes[propKey];
    if (!attributeConfig) {
      continue; // not a valid native prop
    }

    prevProp = prevProps[propKey];
    nextProp = nextProps[propKey];

    // functions are converted to booleans as markers that the associated
    // events should be sent from native.
    if (typeof nextProp === 'function') {
      nextProp = (true : any);
      // If nextProp is not a function, then don't bother changing prevProp
      // since nextProp will win and go into the updatePayload regardless.
      if (typeof prevProp === 'function') {
        prevProp = (true : any);
      }
    }

    // An explicit value of undefined is treated as a null because it overrides
    // any other preceeding value.
    if (typeof nextProp === 'undefined') {
      nextProp = (null : any);
      if (typeof prevProp === 'undefined') {
        prevProp = (null : any);
      }
    }

    if (removedKeys) {
      removedKeys[propKey] = false;
    }

    if (updatePayload && updatePayload[propKey] !== undefined) {
      // Something else already triggered an update to this key because another
      // value diffed. Since we're now later in the nested arrays our value is
      // more important so we need to calculate it and override the existing
      // value. It doesn't matter if nothing changed, we'll set it anyway.

      // Pattern match on: attributeConfig
      if (typeof attributeConfig !== 'object') {
        // case: !Object is the default case
        updatePayload[propKey] = nextProp;
      } else if (typeof attributeConfig.diff === 'function' ||
                 typeof attributeConfig.process === 'function') {
        // case: CustomAttributeConfiguration
        var nextValue = typeof attributeConfig.process === 'function' ?
                        attributeConfig.process(nextProp) :
                        nextProp;
        updatePayload[propKey] = nextValue;
      }
      continue;
    }

    if (prevProp === nextProp) {
      continue; // nothing changed
    }

    // Pattern match on: attributeConfig
    if (typeof attributeConfig !== 'object') {
      // case: !Object is the default case
      if (defaultDiffer(prevProp, nextProp)) {
        // a normal leaf has changed
        (updatePayload || (updatePayload = {}))[propKey] = nextProp;
      }
    } else if (typeof attributeConfig.diff === 'function' ||
               typeof attributeConfig.process === 'function') {
      // case: CustomAttributeConfiguration
      var shouldUpdate = prevProp === undefined || (
        typeof attributeConfig.diff === 'function' ?
        attributeConfig.diff(prevProp, nextProp) :
        defaultDiffer(prevProp, nextProp)
      );
      if (shouldUpdate) {
        nextValue = typeof attributeConfig.process === 'function' ?
                    attributeConfig.process(nextProp) :
                    nextProp;
        (updatePayload || (updatePayload = {}))[propKey] = nextValue;
      }
    } else {
      // default: fallthrough case when nested properties are defined
      removedKeys = null;
      removedKeyCount = 0;
      // We think that attributeConfig is not CustomAttributeConfiguration at
      // this point so we assume it must be AttributeConfiguration.
      // $FlowFixMe
      updatePayload = diffNestedProperty(
        updatePayload,
        prevProp,
        nextProp,
        attributeConfig
      );
      if (removedKeyCount > 0 && updatePayload) {
        restoreDeletedValuesInNestedArray(
          updatePayload,
          nextProp,
          attributeConfig
        );
        removedKeys = null;
      }
    }
  }

  // Also iterate through all the previous props to catch any that have been
  // removed and make sure native gets the signal so it can reset them to the
  // default.
  for (propKey in prevProps) {
    if (nextProps[propKey] !== undefined) {
      continue; // we've already covered this key in the previous pass
    }
    attributeConfig = validAttributes[propKey];
    if (!attributeConfig) {
      continue; // not a valid native prop
    }

    if (updatePayload && updatePayload[propKey] !== undefined) {
      // This was already updated to a diff result earlier.
      continue;
    }

    prevProp = prevProps[propKey];
    if (prevProp === undefined) {
      continue; // was already empty anyway
    }
    // Pattern match on: attributeConfig
    if (typeof attributeConfig !== 'object' ||
        typeof attributeConfig.diff === 'function' ||
        typeof attributeConfig.process === 'function') {

      // case: CustomAttributeConfiguration | !Object
      // Flag the leaf property for removal by sending a sentinel.
      (updatePayload || (updatePayload = {}))[propKey] = null;
      if (!removedKeys) {
        removedKeys = {};
      }
      if (!removedKeys[propKey]) {
        removedKeys[propKey] = true;
        removedKeyCount++;
      }
    } else {
      // default:
      // This is a nested attribute configuration where all the properties
      // were removed so we need to go through and clear out all of them.
      updatePayload = clearNestedProperty(
        updatePayload,
        prevProp,
        attributeConfig
      );
    }
  }
  return updatePayload;
}

/**
 * addProperties adds all the valid props to the payload after being processed.
 */
function addProperties(
  updatePayload: ?Object,
  props: Object,
  validAttributes: AttributeConfiguration
) : ?Object {
  // TODO: Fast path
  return diffProperties(updatePayload, emptyObject, props, validAttributes);
}

/**
 * clearProperties clears all the previous props by adding a null sentinel
 * to the payload for each valid key.
 */
function clearProperties(
  updatePayload: ?Object,
  prevProps: Object,
  validAttributes: AttributeConfiguration
) :? Object {
  // TODO: Fast path
  return diffProperties(updatePayload, prevProps, emptyObject, validAttributes);
}

var ReactNativeAttributePayload = {

  create: function(
    props: Object,
    validAttributes: AttributeConfiguration
  ) : ?Object {
    return addProperties(
      null, // updatePayload
      props,
      validAttributes
    );
  },

  diff: function(
    prevProps: Object,
    nextProps: Object,
    validAttributes: AttributeConfiguration
  ) : ?Object {
    return diffProperties(
      null, // updatePayload
      prevProps,
      nextProps,
      validAttributes
    );
  },

};

module.exports = ReactNativeAttributePayload;
