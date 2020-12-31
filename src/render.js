import { EMPTY_OBJ, EMPTY_ARR } from './constants';
import { commitRoot, diff } from './diff';
import { createElement, Fragment } from './create-element';
import options from './options';

/**
 * Render a Preact virtual node into a DOM element
 * @param {import('./internal').ComponentChild} vnode The virtual node to render
 * @param {import('./internal').PreactElement} parentDom The DOM element to
 * render into
 * @param {import('./internal').PreactElement | object} [replaceNode] Optional: Attempt to re-use an
 * existing DOM tree rooted at `replaceNode`
 */
export function render(vnode, parentDom, replaceNode) {
	if (options._root) {
		options._root(vnode, parentDom);
	}

	// To be able to support calling `render()` multiple times on the same
	// DOM node, we need to obtain a reference to the previous tree. We do
	// this by assigning a new `_children` property to DOM nodes which points
	// to the last rendered tree. By default this property is not present, which
	// means that we are mounting a new tree for the first time.
	const oldVNode =
		(replaceNode && replaceNode._children) || parentDom._children;

	// create wrap component
	const newVNode = createElement(Fragment, null, [vnode]);

	// List of effects that need to be called after diffing.
	const commitQueue = [];

	const isSvg = parentDom.ownerSVGElement !== undefined;

	// Determine the new vnode tree and store it on the DOM element on our custom `_children` property.
	(replaceNode || parentDom)._children = vnode;

	diff(
		parentDom,
		// Determine the new vnode tree and store it on the DOM element on
		// our custom `_children` property.
		newVNode,
		oldVNode || EMPTY_OBJ,
		EMPTY_OBJ,
		isSvg,
		// prettier-ignore
		replaceNode
			? [replaceNode]
			: oldVNode
			  ? null
			  : parentDom.childNodes.length
			    ? EMPTY_ARR.slice.call(parentDom.childNodes)
			    : null,
		commitQueue,
		replaceNode || EMPTY_OBJ
	);

	// Flush all queued effects
	commitRoot(commitQueue, newVNode);
}
