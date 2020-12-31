import { assign } from './util';
import { createVNode } from './create-element';

/**
 * Clones the given VNode, optionally adding attributes/props and replacing its children.
 * @param {import('./internal').VNode} vnode The virtual DOM element to clone
 * @param {object} props Attributes/props to add when cloning
 * @param {Array<import('./internal').ComponentChildren>} rest Any additional arguments will be used as replacement children.
 * @returns {import('./internal').VNode}
 */
export function cloneElement(vnode, props, children) {
	// key, ref should attach on vnode at the begining
	const { key, ref, ...normalizedProps } = assign({}, vnode.props);

	if (arguments.length > 3) {
		children = [children];
		for (i = 3; i < arguments.length; i++) {
			children.push(arguments[i]);
		}
	}

	if (children != null) {
		normalizedProps.children = children;
	}

	return createVNode(
		vnode.type,
		normalizedProps,
		key || vnode.key,
		ref || vnode.ref,
		null
	);
}
