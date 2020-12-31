/**
 * Assign properties from `props` to `obj`
 * @template O, P The obj and props types
 * @param {O} obj The object to copy properties to
 * @param {P} props The object to copy properties from
 * @returns {O & P}
 */
export function assign(obj, props) {
	// @ts-ignore We change the type of `obj` to be `O & P`
	for (let i in props) obj[i] = props[i];

	return /** @type {O & P} */ (obj);
}

/**
 * Remove a child node from its parent if attached. This is a workaround for
 * IE11 which doesn't support `Element.prototype.remove()`. Using this function
 * is smaller than including a dedicated polyfill.
 * @param {Node} node The node to remove
 */
export function removeNode(node) {
	const parentNode = node.parentNode;

	if (parentNode) {
		parentNode.removeChild(node);
	}
}

/**
 * detect plain object type
 * @param {*} value
 * @return {boolean}
 */
export function isObject(value) {
	return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * detect string type
 * @param {string} value
 *
 * @returns {boolean}
 */
export function isString(value) {
	return typeof value === 'string';
}

/**
 * detect vnode as ElementNode
 * @param {import('./internal').VNode} vnode The parent of the VNode that
 *
 * @returns {boolean}
 */
export function isElementNode(vnode) {
	return typeof vnode.type !== 'function';
}
