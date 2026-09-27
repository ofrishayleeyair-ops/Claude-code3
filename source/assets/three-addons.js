/*! Three.js r128 examples/js add-ons bundled for kitsune engine. MIT License, Copyright 2010-2021 Three.js Authors. Each file is unmodified from three@0.128.0/examples/js. */
/* --- three/examples/js/utils/BufferGeometryUtils.js --- */
( function () {

	class BufferGeometryUtils {

		static computeTangents( geometry ) {

			geometry.computeTangents();
			console.warn( 'THREE.BufferGeometryUtils: .computeTangents() has been removed. Use THREE.BufferGeometry.computeTangents() instead.' );

		}
		/**
   * @param  {Array<BufferGeometry>} geometries
   * @param  {Boolean} useGroups
   * @return {BufferGeometry}
   */


		static mergeBufferGeometries( geometries, useGroups = false ) {

			const isIndexed = geometries[ 0 ].index !== null;
			const attributesUsed = new Set( Object.keys( geometries[ 0 ].attributes ) );
			const morphAttributesUsed = new Set( Object.keys( geometries[ 0 ].morphAttributes ) );
			const attributes = {};
			const morphAttributes = {};
			const morphTargetsRelative = geometries[ 0 ].morphTargetsRelative;
			const mergedGeometry = new THREE.BufferGeometry();
			let offset = 0;

			for ( let i = 0; i < geometries.length; ++ i ) {

				const geometry = geometries[ i ];
				let attributesCount = 0; // ensure that all geometries are indexed, or none

				if ( isIndexed !== ( geometry.index !== null ) ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed with geometry at index ' + i + '. All geometries must have compatible attributes; make sure index attribute exists among all geometries, or in none of them.' );
					return null;

				} // gather attributes, exit early if they're different


				for ( const name in geometry.attributes ) {

					if ( ! attributesUsed.has( name ) ) {

						console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed with geometry at index ' + i + '. All geometries must have compatible attributes; make sure "' + name + '" attribute exists among all geometries, or in none of them.' );
						return null;

					}

					if ( attributes[ name ] === undefined ) attributes[ name ] = [];
					attributes[ name ].push( geometry.attributes[ name ] );
					attributesCount ++;

				} // ensure geometries have the same number of attributes


				if ( attributesCount !== attributesUsed.size ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed with geometry at index ' + i + '. Make sure all geometries have the same number of attributes.' );
					return null;

				} // gather morph attributes, exit early if they're different


				if ( morphTargetsRelative !== geometry.morphTargetsRelative ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed with geometry at index ' + i + '. .morphTargetsRelative must be consistent throughout all geometries.' );
					return null;

				}

				for ( const name in geometry.morphAttributes ) {

					if ( ! morphAttributesUsed.has( name ) ) {

						console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed with geometry at index ' + i + '.  .morphAttributes must be consistent throughout all geometries.' );
						return null;

					}

					if ( morphAttributes[ name ] === undefined ) morphAttributes[ name ] = [];
					morphAttributes[ name ].push( geometry.morphAttributes[ name ] );

				} // gather .userData


				mergedGeometry.userData.mergedUserData = mergedGeometry.userData.mergedUserData || [];
				mergedGeometry.userData.mergedUserData.push( geometry.userData );

				if ( useGroups ) {

					let count;

					if ( isIndexed ) {

						count = geometry.index.count;

					} else if ( geometry.attributes.position !== undefined ) {

						count = geometry.attributes.position.count;

					} else {

						console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed with geometry at index ' + i + '. The geometry must have either an index or a position attribute' );
						return null;

					}

					mergedGeometry.addGroup( offset, count, i );
					offset += count;

				}

			} // merge indices


			if ( isIndexed ) {

				let indexOffset = 0;
				const mergedIndex = [];

				for ( let i = 0; i < geometries.length; ++ i ) {

					const index = geometries[ i ].index;

					for ( let j = 0; j < index.count; ++ j ) {

						mergedIndex.push( index.getX( j ) + indexOffset );

					}

					indexOffset += geometries[ i ].attributes.position.count;

				}

				mergedGeometry.setIndex( mergedIndex );

			} // merge attributes


			for ( const name in attributes ) {

				const mergedAttribute = this.mergeBufferAttributes( attributes[ name ] );

				if ( ! mergedAttribute ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed while trying to merge the ' + name + ' attribute.' );
					return null;

				}

				mergedGeometry.setAttribute( name, mergedAttribute );

			} // merge morph attributes


			for ( const name in morphAttributes ) {

				const numMorphTargets = morphAttributes[ name ][ 0 ].length;
				if ( numMorphTargets === 0 ) break;
				mergedGeometry.morphAttributes = mergedGeometry.morphAttributes || {};
				mergedGeometry.morphAttributes[ name ] = [];

				for ( let i = 0; i < numMorphTargets; ++ i ) {

					const morphAttributesToMerge = [];

					for ( let j = 0; j < morphAttributes[ name ].length; ++ j ) {

						morphAttributesToMerge.push( morphAttributes[ name ][ j ][ i ] );

					}

					const mergedMorphAttribute = this.mergeBufferAttributes( morphAttributesToMerge );

					if ( ! mergedMorphAttribute ) {

						console.error( 'THREE.BufferGeometryUtils: .mergeBufferGeometries() failed while trying to merge the ' + name + ' morphAttribute.' );
						return null;

					}

					mergedGeometry.morphAttributes[ name ].push( mergedMorphAttribute );

				}

			}

			return mergedGeometry;

		}
		/**
   * @param {Array<BufferAttribute>} attributes
   * @return {BufferAttribute}
   */


		static mergeBufferAttributes( attributes ) {

			let TypedArray;
			let itemSize;
			let normalized;
			let arrayLength = 0;

			for ( let i = 0; i < attributes.length; ++ i ) {

				const attribute = attributes[ i ];

				if ( attribute.isInterleavedBufferAttribute ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferAttributes() failed. InterleavedBufferAttributes are not supported.' );
					return null;

				}

				if ( TypedArray === undefined ) TypedArray = attribute.array.constructor;

				if ( TypedArray !== attribute.array.constructor ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferAttributes() failed. THREE.BufferAttribute.array must be of consistent array types across matching attributes.' );
					return null;

				}

				if ( itemSize === undefined ) itemSize = attribute.itemSize;

				if ( itemSize !== attribute.itemSize ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferAttributes() failed. THREE.BufferAttribute.itemSize must be consistent across matching attributes.' );
					return null;

				}

				if ( normalized === undefined ) normalized = attribute.normalized;

				if ( normalized !== attribute.normalized ) {

					console.error( 'THREE.BufferGeometryUtils: .mergeBufferAttributes() failed. THREE.BufferAttribute.normalized must be consistent across matching attributes.' );
					return null;

				}

				arrayLength += attribute.array.length;

			}

			const array = new TypedArray( arrayLength );
			let offset = 0;

			for ( let i = 0; i < attributes.length; ++ i ) {

				array.set( attributes[ i ].array, offset );
				offset += attributes[ i ].array.length;

			}

			return new THREE.BufferAttribute( array, itemSize, normalized );

		}
		/**
   * @param {Array<BufferAttribute>} attributes
   * @return {Array<InterleavedBufferAttribute>}
   */


		static interleaveAttributes( attributes ) {

			// Interleaves the provided attributes into an THREE.InterleavedBuffer and returns
			// a set of InterleavedBufferAttributes for each attribute
			let TypedArray;
			let arrayLength = 0;
			let stride = 0; // calculate the the length and type of the interleavedBuffer

			for ( let i = 0, l = attributes.length; i < l; ++ i ) {

				const attribute = attributes[ i ];
				if ( TypedArray === undefined ) TypedArray = attribute.array.constructor;

				if ( TypedArray !== attribute.array.constructor ) {

					console.error( 'AttributeBuffers of different types cannot be interleaved' );
					return null;

				}

				arrayLength += attribute.array.length;
				stride += attribute.itemSize;

			} // Create the set of buffer attributes


			const interleavedBuffer = new THREE.InterleavedBuffer( new TypedArray( arrayLength ), stride );
			let offset = 0;
			const res = [];
			const getters = [ 'getX', 'getY', 'getZ', 'getW' ];
			const setters = [ 'setX', 'setY', 'setZ', 'setW' ];

			for ( let j = 0, l = attributes.length; j < l; j ++ ) {

				const attribute = attributes[ j ];
				const itemSize = attribute.itemSize;
				const count = attribute.count;
				const iba = new THREE.InterleavedBufferAttribute( interleavedBuffer, itemSize, offset, attribute.normalized );
				res.push( iba );
				offset += itemSize; // Move the data for each attribute into the new interleavedBuffer
				// at the appropriate offset

				for ( let c = 0; c < count; c ++ ) {

					for ( let k = 0; k < itemSize; k ++ ) {

						iba[ setters[ k ] ]( c, attribute[ getters[ k ] ]( c ) );

					}

				}

			}

			return res;

		}
		/**
   * @param {Array<BufferGeometry>} geometry
   * @return {number}
   */


		static estimateBytesUsed( geometry ) {

			// Return the estimated memory used by this geometry in bytes
			// Calculate using itemSize, count, and BYTES_PER_ELEMENT to account
			// for InterleavedBufferAttributes.
			let mem = 0;

			for ( const name in geometry.attributes ) {

				const attr = geometry.getAttribute( name );
				mem += attr.count * attr.itemSize * attr.array.BYTES_PER_ELEMENT;

			}

			const indices = geometry.getIndex();
			mem += indices ? indices.count * indices.itemSize * indices.array.BYTES_PER_ELEMENT : 0;
			return mem;

		}
		/**
   * @param {BufferGeometry} geometry
   * @param {number} tolerance
   * @return {BufferGeometry>}
   */


		static mergeVertices( geometry, tolerance = 1e-4 ) {

			tolerance = Math.max( tolerance, Number.EPSILON ); // Generate an index buffer if the geometry doesn't have one, or optimize it
			// if it's already available.

			const hashToIndex = {};
			const indices = geometry.getIndex();
			const positions = geometry.getAttribute( 'position' );
			const vertexCount = indices ? indices.count : positions.count; // next value for triangle indices

			let nextIndex = 0; // attributes and new attribute arrays

			const attributeNames = Object.keys( geometry.attributes );
			const attrArrays = {};
			const morphAttrsArrays = {};
			const newIndices = [];
			const getters = [ 'getX', 'getY', 'getZ', 'getW' ]; // initialize the arrays

			for ( let i = 0, l = attributeNames.length; i < l; i ++ ) {

				const name = attributeNames[ i ];
				attrArrays[ name ] = [];
				const morphAttr = geometry.morphAttributes[ name ];

				if ( morphAttr ) {

					morphAttrsArrays[ name ] = new Array( morphAttr.length ).fill().map( () => [] );

				}

			} // convert the error tolerance to an amount of decimal places to truncate to


			const decimalShift = Math.log10( 1 / tolerance );
			const shiftMultiplier = Math.pow( 10, decimalShift );

			for ( let i = 0; i < vertexCount; i ++ ) {

				const index = indices ? indices.getX( i ) : i; // Generate a hash for the vertex attributes at the current index 'i'

				let hash = '';

				for ( let j = 0, l = attributeNames.length; j < l; j ++ ) {

					const name = attributeNames[ j ];
					const attribute = geometry.getAttribute( name );
					const itemSize = attribute.itemSize;

					for ( let k = 0; k < itemSize; k ++ ) {

						// double tilde truncates the decimal value
						hash += `${~ ~ ( attribute[ getters[ k ] ]( index ) * shiftMultiplier )},`;

					}

				} // Add another reference to the vertex if it's already
				// used by another index


				if ( hash in hashToIndex ) {

					newIndices.push( hashToIndex[ hash ] );

				} else {

					// copy data to the new index in the attribute arrays
					for ( let j = 0, l = attributeNames.length; j < l; j ++ ) {

						const name = attributeNames[ j ];
						const attribute = geometry.getAttribute( name );
						const morphAttr = geometry.morphAttributes[ name ];
						const itemSize = attribute.itemSize;
						const newarray = attrArrays[ name ];
						const newMorphArrays = morphAttrsArrays[ name ];

						for ( let k = 0; k < itemSize; k ++ ) {

							const getterFunc = getters[ k ];
							newarray.push( attribute[ getterFunc ]( index ) );

							if ( morphAttr ) {

								for ( let m = 0, ml = morphAttr.length; m < ml; m ++ ) {

									newMorphArrays[ m ].push( morphAttr[ m ][ getterFunc ]( index ) );

								}

							}

						}

					}

					hashToIndex[ hash ] = nextIndex;
					newIndices.push( nextIndex );
					nextIndex ++;

				}

			} // Generate typed arrays from new attribute arrays and update
			// the attributeBuffers


			const result = geometry.clone();

			for ( let i = 0, l = attributeNames.length; i < l; i ++ ) {

				const name = attributeNames[ i ];
				const oldAttribute = geometry.getAttribute( name );
				const buffer = new oldAttribute.array.constructor( attrArrays[ name ] );
				const attribute = new THREE.BufferAttribute( buffer, oldAttribute.itemSize, oldAttribute.normalized );
				result.setAttribute( name, attribute ); // Update the attribute arrays

				if ( name in morphAttrsArrays ) {

					for ( let j = 0; j < morphAttrsArrays[ name ].length; j ++ ) {

						const oldMorphAttribute = geometry.morphAttributes[ name ][ j ];
						const buffer = new oldMorphAttribute.array.constructor( morphAttrsArrays[ name ][ j ] );
						const morphAttribute = new THREE.BufferAttribute( buffer, oldMorphAttribute.itemSize, oldMorphAttribute.normalized );
						result.morphAttributes[ name ][ j ] = morphAttribute;

					}

				}

			} // indices


			result.setIndex( newIndices );
			return result;

		}
		/**
   * @param {BufferGeometry} geometry
   * @param {number} drawMode
   * @return {BufferGeometry>}
   */


		static toTrianglesDrawMode( geometry, drawMode ) {

			if ( drawMode === THREE.TrianglesDrawMode ) {

				console.warn( 'THREE.BufferGeometryUtils.toTrianglesDrawMode(): Geometry already defined as triangles.' );
				return geometry;

			}

			if ( drawMode === THREE.TriangleFanDrawMode || drawMode === THREE.TriangleStripDrawMode ) {

				let index = geometry.getIndex(); // generate index if not present

				if ( index === null ) {

					const indices = [];
					const position = geometry.getAttribute( 'position' );

					if ( position !== undefined ) {

						for ( let i = 0; i < position.count; i ++ ) {

							indices.push( i );

						}

						geometry.setIndex( indices );
						index = geometry.getIndex();

					} else {

						console.error( 'THREE.BufferGeometryUtils.toTrianglesDrawMode(): Undefined position attribute. Processing not possible.' );
						return geometry;

					}

				} //


				const numberOfTriangles = index.count - 2;
				const newIndices = [];

				if ( drawMode === THREE.TriangleFanDrawMode ) {

					// gl.TRIANGLE_FAN
					for ( let i = 1; i <= numberOfTriangles; i ++ ) {

						newIndices.push( index.getX( 0 ) );
						newIndices.push( index.getX( i ) );
						newIndices.push( index.getX( i + 1 ) );

					}

				} else {

					// gl.TRIANGLE_STRIP
					for ( let i = 0; i < numberOfTriangles; i ++ ) {

						if ( i % 2 === 0 ) {

							newIndices.push( index.getX( i ) );
							newIndices.push( index.getX( i + 1 ) );
							newIndices.push( index.getX( i + 2 ) );

						} else {

							newIndices.push( index.getX( i + 2 ) );
							newIndices.push( index.getX( i + 1 ) );
							newIndices.push( index.getX( i ) );

						}

					}

				}

				if ( newIndices.length / 3 !== numberOfTriangles ) {

					console.error( 'THREE.BufferGeometryUtils.toTrianglesDrawMode(): Unable to generate correct amount of triangles.' );

				} // build final geometry


				const newGeometry = geometry.clone();
				newGeometry.setIndex( newIndices );
				newGeometry.clearGroups();
				return newGeometry;

			} else {

				console.error( 'THREE.BufferGeometryUtils.toTrianglesDrawMode(): Unknown draw mode:', drawMode );
				return geometry;

			}

		}
		/**
   * Calculates the morphed attributes of a morphed/skinned THREE.BufferGeometry.
   * Helpful for Raytracing or Decals.
   * @param {Mesh | Line | Points} object An instance of Mesh, Line or Points.
   * @return {Object} An Object with original position/normal attributes and morphed ones.
   */


		static computeMorphedAttributes( object ) {

			if ( object.geometry.isBufferGeometry !== true ) {

				console.error( 'THREE.BufferGeometryUtils: Geometry is not of type THREE.BufferGeometry.' );
				return null;

			}

			const _vA = new THREE.Vector3();

			const _vB = new THREE.Vector3();

			const _vC = new THREE.Vector3();

			const _tempA = new THREE.Vector3();

			const _tempB = new THREE.Vector3();

			const _tempC = new THREE.Vector3();

			const _morphA = new THREE.Vector3();

			const _morphB = new THREE.Vector3();

			const _morphC = new THREE.Vector3();

			function _calculateMorphedAttributeData( object, material, attribute, morphAttribute, morphTargetsRelative, a, b, c, modifiedAttributeArray ) {

				_vA.fromBufferAttribute( attribute, a );

				_vB.fromBufferAttribute( attribute, b );

				_vC.fromBufferAttribute( attribute, c );

				const morphInfluences = object.morphTargetInfluences;

				if ( material.morphTargets && morphAttribute && morphInfluences ) {

					_morphA.set( 0, 0, 0 );

					_morphB.set( 0, 0, 0 );

					_morphC.set( 0, 0, 0 );

					for ( let i = 0, il = morphAttribute.length; i < il; i ++ ) {

						const influence = morphInfluences[ i ];
						const morph = morphAttribute[ i ];
						if ( influence === 0 ) continue;

						_tempA.fromBufferAttribute( morph, a );

						_tempB.fromBufferAttribute( morph, b );

						_tempC.fromBufferAttribute( morph, c );

						if ( morphTargetsRelative ) {

							_morphA.addScaledVector( _tempA, influence );

							_morphB.addScaledVector( _tempB, influence );

							_morphC.addScaledVector( _tempC, influence );

						} else {

							_morphA.addScaledVector( _tempA.sub( _vA ), influence );

							_morphB.addScaledVector( _tempB.sub( _vB ), influence );

							_morphC.addScaledVector( _tempC.sub( _vC ), influence );

						}

					}

					_vA.add( _morphA );

					_vB.add( _morphB );

					_vC.add( _morphC );

				}

				if ( object.isSkinnedMesh ) {

					object.boneTransform( a, _vA );
					object.boneTransform( b, _vB );
					object.boneTransform( c, _vC );

				}

				modifiedAttributeArray[ a * 3 + 0 ] = _vA.x;
				modifiedAttributeArray[ a * 3 + 1 ] = _vA.y;
				modifiedAttributeArray[ a * 3 + 2 ] = _vA.z;
				modifiedAttributeArray[ b * 3 + 0 ] = _vB.x;
				modifiedAttributeArray[ b * 3 + 1 ] = _vB.y;
				modifiedAttributeArray[ b * 3 + 2 ] = _vB.z;
				modifiedAttributeArray[ c * 3 + 0 ] = _vC.x;
				modifiedAttributeArray[ c * 3 + 1 ] = _vC.y;
				modifiedAttributeArray[ c * 3 + 2 ] = _vC.z;

			}

			const geometry = object.geometry;
			const material = object.material;
			let a, b, c;
			const index = geometry.index;
			const positionAttribute = geometry.attributes.position;
			const morphPosition = geometry.morphAttributes.position;
			const morphTargetsRelative = geometry.morphTargetsRelative;
			const normalAttribute = geometry.attributes.normal;
			const morphNormal = geometry.morphAttributes.position;
			const groups = geometry.groups;
			const drawRange = geometry.drawRange;
			let i, j, il, jl;
			let group, groupMaterial;
			let start, end;
			const modifiedPosition = new Float32Array( positionAttribute.count * positionAttribute.itemSize );
			const modifiedNormal = new Float32Array( normalAttribute.count * normalAttribute.itemSize );

			if ( index !== null ) {

				// indexed buffer geometry
				if ( Array.isArray( material ) ) {

					for ( i = 0, il = groups.length; i < il; i ++ ) {

						group = groups[ i ];
						groupMaterial = material[ group.materialIndex ];
						start = Math.max( group.start, drawRange.start );
						end = Math.min( group.start + group.count, drawRange.start + drawRange.count );

						for ( j = start, jl = end; j < jl; j += 3 ) {

							a = index.getX( j );
							b = index.getX( j + 1 );
							c = index.getX( j + 2 );

							_calculateMorphedAttributeData( object, groupMaterial, positionAttribute, morphPosition, morphTargetsRelative, a, b, c, modifiedPosition );

							_calculateMorphedAttributeData( object, groupMaterial, normalAttribute, morphNormal, morphTargetsRelative, a, b, c, modifiedNormal );

						}

					}

				} else {

					start = Math.max( 0, drawRange.start );
					end = Math.min( index.count, drawRange.start + drawRange.count );

					for ( i = start, il = end; i < il; i += 3 ) {

						a = index.getX( i );
						b = index.getX( i + 1 );
						c = index.getX( i + 2 );

						_calculateMorphedAttributeData( object, material, positionAttribute, morphPosition, morphTargetsRelative, a, b, c, modifiedPosition );

						_calculateMorphedAttributeData( object, material, normalAttribute, morphNormal, morphTargetsRelative, a, b, c, modifiedNormal );

					}

				}

			} else if ( positionAttribute !== undefined ) {

				// non-indexed buffer geometry
				if ( Array.isArray( material ) ) {

					for ( i = 0, il = groups.length; i < il; i ++ ) {

						group = groups[ i ];
						groupMaterial = material[ group.materialIndex ];
						start = Math.max( group.start, drawRange.start );
						end = Math.min( group.start + group.count, drawRange.start + drawRange.count );

						for ( j = start, jl = end; j < jl; j += 3 ) {

							a = j;
							b = j + 1;
							c = j + 2;

							_calculateMorphedAttributeData( object, groupMaterial, positionAttribute, morphPosition, morphTargetsRelative, a, b, c, modifiedPosition );

							_calculateMorphedAttributeData( object, groupMaterial, normalAttribute, morphNormal, morphTargetsRelative, a, b, c, modifiedNormal );

						}

					}

				} else {

					start = Math.max( 0, drawRange.start );
					end = Math.min( positionAttribute.count, drawRange.start + drawRange.count );

					for ( i = start, il = end; i < il; i += 3 ) {

						a = i;
						b = i + 1;
						c = i + 2;

						_calculateMorphedAttributeData( object, material, positionAttribute, morphPosition, morphTargetsRelative, a, b, c, modifiedPosition );

						_calculateMorphedAttributeData( object, material, normalAttribute, morphNormal, morphTargetsRelative, a, b, c, modifiedNormal );

					}

				}

			}

			const morphedPositionAttribute = new THREE.Float32BufferAttribute( modifiedPosition, 3 );
			const morphedNormalAttribute = new THREE.Float32BufferAttribute( modifiedNormal, 3 );
			return {
				positionAttribute: positionAttribute,
				normalAttribute: normalAttribute,
				morphedPositionAttribute: morphedPositionAttribute,
				morphedNormalAttribute: morphedNormalAttribute
			};

		}

	}

	THREE.BufferGeometryUtils = BufferGeometryUtils;

} )();

/* --- three/examples/js/utils/SkeletonUtils.js --- */
( function () {

	class SkeletonUtils {

		static retarget( target, source, options = {} ) {

			const pos = new THREE.Vector3(),
				quat = new THREE.Quaternion(),
				scale = new THREE.Vector3(),
				bindBoneMatrix = new THREE.Matrix4(),
				relativeMatrix = new THREE.Matrix4(),
				globalMatrix = new THREE.Matrix4();
			options.preserveMatrix = options.preserveMatrix !== undefined ? options.preserveMatrix : true;
			options.preservePosition = options.preservePosition !== undefined ? options.preservePosition : true;
			options.preserveHipPosition = options.preserveHipPosition !== undefined ? options.preserveHipPosition : false;
			options.useTargetMatrix = options.useTargetMatrix !== undefined ? options.useTargetMatrix : false;
			options.hip = options.hip !== undefined ? options.hip : 'hip';
			options.names = options.names || {};
			const sourceBones = source.isObject3D ? source.skeleton.bones : this.getBones( source ),
				bones = target.isObject3D ? target.skeleton.bones : this.getBones( target );
			let bindBones, bone, name, boneTo, bonesPosition; // reset bones

			if ( target.isObject3D ) {

				target.skeleton.pose();

			} else {

				options.useTargetMatrix = true;
				options.preserveMatrix = false;

			}

			if ( options.preservePosition ) {

				bonesPosition = [];

				for ( let i = 0; i < bones.length; i ++ ) {

					bonesPosition.push( bones[ i ].position.clone() );

				}

			}

			if ( options.preserveMatrix ) {

				// reset matrix
				target.updateMatrixWorld();
				target.matrixWorld.identity(); // reset children matrix

				for ( let i = 0; i < target.children.length; ++ i ) {

					target.children[ i ].updateMatrixWorld( true );

				}

			}

			if ( options.offsets ) {

				bindBones = [];

				for ( let i = 0; i < bones.length; ++ i ) {

					bone = bones[ i ];
					name = options.names[ bone.name ] || bone.name;

					if ( options.offsets && options.offsets[ name ] ) {

						bone.matrix.multiply( options.offsets[ name ] );
						bone.matrix.decompose( bone.position, bone.quaternion, bone.scale );
						bone.updateMatrixWorld();

					}

					bindBones.push( bone.matrixWorld.clone() );

				}

			}

			for ( let i = 0; i < bones.length; ++ i ) {

				bone = bones[ i ];
				name = options.names[ bone.name ] || bone.name;
				boneTo = this.getBoneByName( name, sourceBones );
				globalMatrix.copy( bone.matrixWorld );

				if ( boneTo ) {

					boneTo.updateMatrixWorld();

					if ( options.useTargetMatrix ) {

						relativeMatrix.copy( boneTo.matrixWorld );

					} else {

						relativeMatrix.copy( target.matrixWorld ).invert();
						relativeMatrix.multiply( boneTo.matrixWorld );

					} // ignore scale to extract rotation


					scale.setFromMatrixScale( relativeMatrix );
					relativeMatrix.scale( scale.set( 1 / scale.x, 1 / scale.y, 1 / scale.z ) ); // apply to global matrix

					globalMatrix.makeRotationFromQuaternion( quat.setFromRotationMatrix( relativeMatrix ) );

					if ( target.isObject3D ) {

						const boneIndex = bones.indexOf( bone ),
							wBindMatrix = bindBones ? bindBones[ boneIndex ] : bindBoneMatrix.copy( target.skeleton.boneInverses[ boneIndex ] ).invert();
						globalMatrix.multiply( wBindMatrix );

					}

					globalMatrix.copyPosition( relativeMatrix );

				}

				if ( bone.parent && bone.parent.isBone ) {

					bone.matrix.copy( bone.parent.matrixWorld ).invert();
					bone.matrix.multiply( globalMatrix );

				} else {

					bone.matrix.copy( globalMatrix );

				}

				if ( options.preserveHipPosition && name === options.hip ) {

					bone.matrix.setPosition( pos.set( 0, bone.position.y, 0 ) );

				}

				bone.matrix.decompose( bone.position, bone.quaternion, bone.scale );
				bone.updateMatrixWorld();

			}

			if ( options.preservePosition ) {

				for ( let i = 0; i < bones.length; ++ i ) {

					bone = bones[ i ];
					name = options.names[ bone.name ] || bone.name;

					if ( name !== options.hip ) {

						bone.position.copy( bonesPosition[ i ] );

					}

				}

			}

			if ( options.preserveMatrix ) {

				// restore matrix
				target.updateMatrixWorld( true );

			}

		}

		static retargetClip( target, source, clip, options = {} ) {

			options.useFirstFramePosition = options.useFirstFramePosition !== undefined ? options.useFirstFramePosition : false;
			options.fps = options.fps !== undefined ? options.fps : 30;
			options.names = options.names || [];

			if ( ! source.isObject3D ) {

				source = this.getHelperFromSkeleton( source );

			}

			const numFrames = Math.round( clip.duration * ( options.fps / 1000 ) * 1000 ),
				delta = 1 / options.fps,
				convertedTracks = [],
				mixer = new THREE.AnimationMixer( source ),
				bones = this.getBones( target.skeleton ),
				boneDatas = [];
			let positionOffset, bone, boneTo, boneData, name;
			mixer.clipAction( clip ).play();
			mixer.update( 0 );
			source.updateMatrixWorld();

			for ( let i = 0; i < numFrames; ++ i ) {

				const time = i * delta;
				this.retarget( target, source, options );

				for ( let j = 0; j < bones.length; ++ j ) {

					name = options.names[ bones[ j ].name ] || bones[ j ].name;
					boneTo = this.getBoneByName( name, source.skeleton );

					if ( boneTo ) {

						bone = bones[ j ];
						boneData = boneDatas[ j ] = boneDatas[ j ] || {
							bone: bone
						};

						if ( options.hip === name ) {

							if ( ! boneData.pos ) {

								boneData.pos = {
									times: new Float32Array( numFrames ),
									values: new Float32Array( numFrames * 3 )
								};

							}

							if ( options.useFirstFramePosition ) {

								if ( i === 0 ) {

									positionOffset = bone.position.clone();

								}

								bone.position.sub( positionOffset );

							}

							boneData.pos.times[ i ] = time;
							bone.position.toArray( boneData.pos.values, i * 3 );

						}

						if ( ! boneData.quat ) {

							boneData.quat = {
								times: new Float32Array( numFrames ),
								values: new Float32Array( numFrames * 4 )
							};

						}

						boneData.quat.times[ i ] = time;
						bone.quaternion.toArray( boneData.quat.values, i * 4 );

					}

				}

				mixer.update( delta );
				source.updateMatrixWorld();

			}

			for ( let i = 0; i < boneDatas.length; ++ i ) {

				boneData = boneDatas[ i ];

				if ( boneData ) {

					if ( boneData.pos ) {

						convertedTracks.push( new THREE.VectorKeyframeTrack( '.bones[' + boneData.bone.name + '].position', boneData.pos.times, boneData.pos.values ) );

					}

					convertedTracks.push( new THREE.QuaternionKeyframeTrack( '.bones[' + boneData.bone.name + '].quaternion', boneData.quat.times, boneData.quat.values ) );

				}

			}

			mixer.uncacheAction( clip );
			return new THREE.AnimationClip( clip.name, - 1, convertedTracks );

		}

		static getHelperFromSkeleton( skeleton ) {

			const source = new THREE.SkeletonHelper( skeleton.bones[ 0 ] );
			source.skeleton = skeleton;
			return source;

		}

		static getSkeletonOffsets( target, source, options = {} ) {

			const targetParentPos = new THREE.Vector3(),
				targetPos = new THREE.Vector3(),
				sourceParentPos = new THREE.Vector3(),
				sourcePos = new THREE.Vector3(),
				targetDir = new THREE.Vector2(),
				sourceDir = new THREE.Vector2();
			options.hip = options.hip !== undefined ? options.hip : 'hip';
			options.names = options.names || {};

			if ( ! source.isObject3D ) {

				source = this.getHelperFromSkeleton( source );

			}

			const nameKeys = Object.keys( options.names ),
				nameValues = Object.values( options.names ),
				sourceBones = source.isObject3D ? source.skeleton.bones : this.getBones( source ),
				bones = target.isObject3D ? target.skeleton.bones : this.getBones( target ),
				offsets = [];
			let bone, boneTo, name, i;
			target.skeleton.pose();

			for ( i = 0; i < bones.length; ++ i ) {

				bone = bones[ i ];
				name = options.names[ bone.name ] || bone.name;
				boneTo = this.getBoneByName( name, sourceBones );

				if ( boneTo && name !== options.hip ) {

					const boneParent = this.getNearestBone( bone.parent, nameKeys ),
						boneToParent = this.getNearestBone( boneTo.parent, nameValues );
					boneParent.updateMatrixWorld();
					boneToParent.updateMatrixWorld();
					targetParentPos.setFromMatrixPosition( boneParent.matrixWorld );
					targetPos.setFromMatrixPosition( bone.matrixWorld );
					sourceParentPos.setFromMatrixPosition( boneToParent.matrixWorld );
					sourcePos.setFromMatrixPosition( boneTo.matrixWorld );
					targetDir.subVectors( new THREE.Vector2( targetPos.x, targetPos.y ), new THREE.Vector2( targetParentPos.x, targetParentPos.y ) ).normalize();
					sourceDir.subVectors( new THREE.Vector2( sourcePos.x, sourcePos.y ), new THREE.Vector2( sourceParentPos.x, sourceParentPos.y ) ).normalize();
					const laterialAngle = targetDir.angle() - sourceDir.angle();
					const offset = new THREE.Matrix4().makeRotationFromEuler( new THREE.Euler( 0, 0, laterialAngle ) );
					bone.matrix.multiply( offset );
					bone.matrix.decompose( bone.position, bone.quaternion, bone.scale );
					bone.updateMatrixWorld();
					offsets[ name ] = offset;

				}

			}

			return offsets;

		}

		static renameBones( skeleton, names ) {

			const bones = this.getBones( skeleton );

			for ( let i = 0; i < bones.length; ++ i ) {

				const bone = bones[ i ];

				if ( names[ bone.name ] ) {

					bone.name = names[ bone.name ];

				}

			}

			return this;

		}

		static getBones( skeleton ) {

			return Array.isArray( skeleton ) ? skeleton : skeleton.bones;

		}

		static getBoneByName( name, skeleton ) {

			for ( let i = 0, bones = this.getBones( skeleton ); i < bones.length; i ++ ) {

				if ( name === bones[ i ].name ) return bones[ i ];

			}

		}

		static getNearestBone( bone, names ) {

			while ( bone.isBone ) {

				if ( names.indexOf( bone.name ) !== - 1 ) {

					return bone;

				}

				bone = bone.parent;

			}

		}

		static findBoneTrackData( name, tracks ) {

			const regexp = /\[(.*)\]\.(.*)/,
				result = {
					name: name
				};

			for ( let i = 0; i < tracks.length; ++ i ) {

				// 1 is track name
				// 2 is track type
				const trackData = regexp.exec( tracks[ i ].name );

				if ( trackData && name === trackData[ 1 ] ) {

					result[ trackData[ 2 ] ] = i;

				}

			}

			return result;

		}

		static getEqualsBonesNames( skeleton, targetSkeleton ) {

			const sourceBones = this.getBones( skeleton ),
				targetBones = this.getBones( targetSkeleton ),
				bones = [];

			search: for ( let i = 0; i < sourceBones.length; i ++ ) {

				const boneName = sourceBones[ i ].name;

				for ( let j = 0; j < targetBones.length; j ++ ) {

					if ( boneName === targetBones[ j ].name ) {

						bones.push( boneName );
						continue search;

					}

				}

			}

			return bones;

		}

		static clone( source ) {

			const sourceLookup = new Map();
			const cloneLookup = new Map();
			const clone = source.clone();
			parallelTraverse( source, clone, function ( sourceNode, clonedNode ) {

				sourceLookup.set( clonedNode, sourceNode );
				cloneLookup.set( sourceNode, clonedNode );

			} );
			clone.traverse( function ( node ) {

				if ( ! node.isSkinnedMesh ) return;
				const clonedMesh = node;
				const sourceMesh = sourceLookup.get( node );
				const sourceBones = sourceMesh.skeleton.bones;
				clonedMesh.skeleton = sourceMesh.skeleton.clone();
				clonedMesh.bindMatrix.copy( sourceMesh.bindMatrix );
				clonedMesh.skeleton.bones = sourceBones.map( function ( bone ) {

					return cloneLookup.get( bone );

				} );
				clonedMesh.bind( clonedMesh.skeleton, clonedMesh.bindMatrix );

			} );
			return clone;

		}

	}

	function parallelTraverse( a, b, callback ) {

		callback( a, b );

		for ( let i = 0; i < a.children.length; i ++ ) {

			parallelTraverse( a.children[ i ], b.children[ i ], callback );

		}

	}

	THREE.SkeletonUtils = SkeletonUtils;

} )();

/* --- three/examples/js/math/ConvexHull.js --- */
( function () {

	/**
 * Ported from: https://github.com/maurizzzio/quickhull3d/ by Mauricio Poppe (https://github.com/maurizzzio)
 */

	const Visible = 0;
	const Deleted = 1;

	const _v1 = new THREE.Vector3();

	const _line3 = new THREE.Line3();

	const _plane = new THREE.Plane();

	const _closestPoint = new THREE.Vector3();

	const _triangle = new THREE.Triangle();

	class ConvexHull {

		constructor() {

			this.tolerance = - 1;
			this.faces = []; // the generated faces of the convex hull

			this.newFaces = []; // this array holds the faces that are generated within a single iteration
			// the vertex lists work as follows:
			//
			// let 'a' and 'b' be 'Face' instances
			// let 'v' be points wrapped as instance of 'Vertex'
			//
			//     [v, v, ..., v, v, v, ...]
			//      ^             ^
			//      |             |
			//  a.outside     b.outside
			//

			this.assigned = new VertexList();
			this.unassigned = new VertexList();
			this.vertices = []; // vertices of the hull (internal representation of given geometry data)

		}

		setFromPoints( points ) {

			if ( Array.isArray( points ) !== true ) {

				console.error( 'THREE.ConvexHull: Points parameter is not an array.' );

			}

			if ( points.length < 4 ) {

				console.error( 'THREE.ConvexHull: The algorithm needs at least four points.' );

			}

			this.makeEmpty();

			for ( let i = 0, l = points.length; i < l; i ++ ) {

				this.vertices.push( new VertexNode( points[ i ] ) );

			}

			this.compute();
			return this;

		}

		setFromObject( object ) {

			const points = [];
			object.updateMatrixWorld( true );
			object.traverse( function ( node ) {

				const geometry = node.geometry;

				if ( geometry !== undefined ) {

					if ( geometry.isGeometry ) {

						console.error( 'THREE.ConvexHull no longer supports Geometry. Use THREE.BufferGeometry instead.' );
						return;

					} else if ( geometry.isBufferGeometry ) {

						const attribute = geometry.attributes.position;

						if ( attribute !== undefined ) {

							for ( let i = 0, l = attribute.count; i < l; i ++ ) {

								const point = new THREE.Vector3();
								point.fromBufferAttribute( attribute, i ).applyMatrix4( node.matrixWorld );
								points.push( point );

							}

						}

					}

				}

			} );
			return this.setFromPoints( points );

		}

		containsPoint( point ) {

			const faces = this.faces;

			for ( let i = 0, l = faces.length; i < l; i ++ ) {

				const face = faces[ i ]; // compute signed distance and check on what half space the point lies

				if ( face.distanceToPoint( point ) > this.tolerance ) return false;

			}

			return true;

		}

		intersectRay( ray, target ) {

			// based on "Fast Ray-Convex Polyhedron Intersection"  by Eric Haines, GRAPHICS GEMS II
			const faces = this.faces;
			let tNear = - Infinity;
			let tFar = Infinity;

			for ( let i = 0, l = faces.length; i < l; i ++ ) {

				const face = faces[ i ]; // interpret faces as planes for the further computation

				const vN = face.distanceToPoint( ray.origin );
				const vD = face.normal.dot( ray.direction ); // if the origin is on the positive side of a plane (so the plane can "see" the origin) and
				// the ray is turned away or parallel to the plane, there is no intersection

				if ( vN > 0 && vD >= 0 ) return null; // compute the distance from the ray’s origin to the intersection with the plane

				const t = vD !== 0 ? - vN / vD : 0; // only proceed if the distance is positive. a negative distance means the intersection point
				// lies "behind" the origin

				if ( t <= 0 ) continue; // now categorized plane as front-facing or back-facing

				if ( vD > 0 ) {

					//  plane faces away from the ray, so this plane is a back-face
					tFar = Math.min( t, tFar );

				} else {

					// front-face
					tNear = Math.max( t, tNear );

				}

				if ( tNear > tFar ) {

					// if tNear ever is greater than tFar, the ray must miss the convex hull
					return null;

				}

			} // evaluate intersection point
			// always try tNear first since its the closer intersection point


			if ( tNear !== - Infinity ) {

				ray.at( tNear, target );

			} else {

				ray.at( tFar, target );

			}

			return target;

		}

		intersectsRay( ray ) {

			return this.intersectRay( ray, _v1 ) !== null;

		}

		makeEmpty() {

			this.faces = [];
			this.vertices = [];
			return this;

		} // Adds a vertex to the 'assigned' list of vertices and assigns it to the given face


		addVertexToFace( vertex, face ) {

			vertex.face = face;

			if ( face.outside === null ) {

				this.assigned.append( vertex );

			} else {

				this.assigned.insertBefore( face.outside, vertex );

			}

			face.outside = vertex;
			return this;

		} // Removes a vertex from the 'assigned' list of vertices and from the given face


		removeVertexFromFace( vertex, face ) {

			if ( vertex === face.outside ) {

				// fix face.outside link
				if ( vertex.next !== null && vertex.next.face === face ) {

					// face has at least 2 outside vertices, move the 'outside' reference
					face.outside = vertex.next;

				} else {

					// vertex was the only outside vertex that face had
					face.outside = null;

				}

			}

			this.assigned.remove( vertex );
			return this;

		} // Removes all the visible vertices that a given face is able to see which are stored in the 'assigned' vertext list


		removeAllVerticesFromFace( face ) {

			if ( face.outside !== null ) {

				// reference to the first and last vertex of this face
				const start = face.outside;
				let end = face.outside;

				while ( end.next !== null && end.next.face === face ) {

					end = end.next;

				}

				this.assigned.removeSubList( start, end ); // fix references

				start.prev = end.next = null;
				face.outside = null;
				return start;

			}

		} // Removes all the visible vertices that 'face' is able to see


		deleteFaceVertices( face, absorbingFace ) {

			const faceVertices = this.removeAllVerticesFromFace( face );

			if ( faceVertices !== undefined ) {

				if ( absorbingFace === undefined ) {

					// mark the vertices to be reassigned to some other face
					this.unassigned.appendChain( faceVertices );

				} else {

					// if there's an absorbing face try to assign as many vertices as possible to it
					let vertex = faceVertices;

					do {

						// we need to buffer the subsequent vertex at this point because the 'vertex.next' reference
						// will be changed by upcoming method calls
						const nextVertex = vertex.next;
						const distance = absorbingFace.distanceToPoint( vertex.point ); // check if 'vertex' is able to see 'absorbingFace'

						if ( distance > this.tolerance ) {

							this.addVertexToFace( vertex, absorbingFace );

						} else {

							this.unassigned.append( vertex );

						} // now assign next vertex


						vertex = nextVertex;

					} while ( vertex !== null );

				}

			}

			return this;

		} // Reassigns as many vertices as possible from the unassigned list to the new faces


		resolveUnassignedPoints( newFaces ) {

			if ( this.unassigned.isEmpty() === false ) {

				let vertex = this.unassigned.first();

				do {

					// buffer 'next' reference, see .deleteFaceVertices()
					const nextVertex = vertex.next;
					let maxDistance = this.tolerance;
					let maxFace = null;

					for ( let i = 0; i < newFaces.length; i ++ ) {

						const face = newFaces[ i ];

						if ( face.mark === Visible ) {

							const distance = face.distanceToPoint( vertex.point );

							if ( distance > maxDistance ) {

								maxDistance = distance;
								maxFace = face;

							}

							if ( maxDistance > 1000 * this.tolerance ) break;

						}

					} // 'maxFace' can be null e.g. if there are identical vertices


					if ( maxFace !== null ) {

						this.addVertexToFace( vertex, maxFace );

					}

					vertex = nextVertex;

				} while ( vertex !== null );

			}

			return this;

		} // Computes the extremes of a simplex which will be the initial hull


		computeExtremes() {

			const min = new THREE.Vector3();
			const max = new THREE.Vector3();
			const minVertices = [];
			const maxVertices = []; // initially assume that the first vertex is the min/max

			for ( let i = 0; i < 3; i ++ ) {

				minVertices[ i ] = maxVertices[ i ] = this.vertices[ 0 ];

			}

			min.copy( this.vertices[ 0 ].point );
			max.copy( this.vertices[ 0 ].point ); // compute the min/max vertex on all six directions

			for ( let i = 0, l = this.vertices.length; i < l; i ++ ) {

				const vertex = this.vertices[ i ];
				const point = vertex.point; // update the min coordinates

				for ( let j = 0; j < 3; j ++ ) {

					if ( point.getComponent( j ) < min.getComponent( j ) ) {

						min.setComponent( j, point.getComponent( j ) );
						minVertices[ j ] = vertex;

					}

				} // update the max coordinates


				for ( let j = 0; j < 3; j ++ ) {

					if ( point.getComponent( j ) > max.getComponent( j ) ) {

						max.setComponent( j, point.getComponent( j ) );
						maxVertices[ j ] = vertex;

					}

				}

			} // use min/max vectors to compute an optimal epsilon


			this.tolerance = 3 * Number.EPSILON * ( Math.max( Math.abs( min.x ), Math.abs( max.x ) ) + Math.max( Math.abs( min.y ), Math.abs( max.y ) ) + Math.max( Math.abs( min.z ), Math.abs( max.z ) ) );
			return {
				min: minVertices,
				max: maxVertices
			};

		} // Computes the initial simplex assigning to its faces all the points
		// that are candidates to form part of the hull


		computeInitialHull() {

			const vertices = this.vertices;
			const extremes = this.computeExtremes();
			const min = extremes.min;
			const max = extremes.max; // 1. Find the two vertices 'v0' and 'v1' with the greatest 1d separation
			// (max.x - min.x)
			// (max.y - min.y)
			// (max.z - min.z)

			let maxDistance = 0;
			let index = 0;

			for ( let i = 0; i < 3; i ++ ) {

				const distance = max[ i ].point.getComponent( i ) - min[ i ].point.getComponent( i );

				if ( distance > maxDistance ) {

					maxDistance = distance;
					index = i;

				}

			}

			const v0 = min[ index ];
			const v1 = max[ index ];
			let v2;
			let v3; // 2. The next vertex 'v2' is the one farthest to the line formed by 'v0' and 'v1'

			maxDistance = 0;

			_line3.set( v0.point, v1.point );

			for ( let i = 0, l = this.vertices.length; i < l; i ++ ) {

				const vertex = vertices[ i ];

				if ( vertex !== v0 && vertex !== v1 ) {

					_line3.closestPointToPoint( vertex.point, true, _closestPoint );

					const distance = _closestPoint.distanceToSquared( vertex.point );

					if ( distance > maxDistance ) {

						maxDistance = distance;
						v2 = vertex;

					}

				}

			} // 3. The next vertex 'v3' is the one farthest to the plane 'v0', 'v1', 'v2'


			maxDistance = - 1;

			_plane.setFromCoplanarPoints( v0.point, v1.point, v2.point );

			for ( let i = 0, l = this.vertices.length; i < l; i ++ ) {

				const vertex = vertices[ i ];

				if ( vertex !== v0 && vertex !== v1 && vertex !== v2 ) {

					const distance = Math.abs( _plane.distanceToPoint( vertex.point ) );

					if ( distance > maxDistance ) {

						maxDistance = distance;
						v3 = vertex;

					}

				}

			}

			const faces = [];

			if ( _plane.distanceToPoint( v3.point ) < 0 ) {

				// the face is not able to see the point so 'plane.normal' is pointing outside the tetrahedron
				faces.push( Face.create( v0, v1, v2 ), Face.create( v3, v1, v0 ), Face.create( v3, v2, v1 ), Face.create( v3, v0, v2 ) ); // set the twin edge

				for ( let i = 0; i < 3; i ++ ) {

					const j = ( i + 1 ) % 3; // join face[ i ] i > 0, with the first face

					faces[ i + 1 ].getEdge( 2 ).setTwin( faces[ 0 ].getEdge( j ) ); // join face[ i ] with face[ i + 1 ], 1 <= i <= 3

					faces[ i + 1 ].getEdge( 1 ).setTwin( faces[ j + 1 ].getEdge( 0 ) );

				}

			} else {

				// the face is able to see the point so 'plane.normal' is pointing inside the tetrahedron
				faces.push( Face.create( v0, v2, v1 ), Face.create( v3, v0, v1 ), Face.create( v3, v1, v2 ), Face.create( v3, v2, v0 ) ); // set the twin edge

				for ( let i = 0; i < 3; i ++ ) {

					const j = ( i + 1 ) % 3; // join face[ i ] i > 0, with the first face

					faces[ i + 1 ].getEdge( 2 ).setTwin( faces[ 0 ].getEdge( ( 3 - i ) % 3 ) ); // join face[ i ] with face[ i + 1 ]

					faces[ i + 1 ].getEdge( 0 ).setTwin( faces[ j + 1 ].getEdge( 1 ) );

				}

			} // the initial hull is the tetrahedron


			for ( let i = 0; i < 4; i ++ ) {

				this.faces.push( faces[ i ] );

			} // initial assignment of vertices to the faces of the tetrahedron


			for ( let i = 0, l = vertices.length; i < l; i ++ ) {

				const vertex = vertices[ i ];

				if ( vertex !== v0 && vertex !== v1 && vertex !== v2 && vertex !== v3 ) {

					maxDistance = this.tolerance;
					let maxFace = null;

					for ( let j = 0; j < 4; j ++ ) {

						const distance = this.faces[ j ].distanceToPoint( vertex.point );

						if ( distance > maxDistance ) {

							maxDistance = distance;
							maxFace = this.faces[ j ];

						}

					}

					if ( maxFace !== null ) {

						this.addVertexToFace( vertex, maxFace );

					}

				}

			}

			return this;

		} // Removes inactive faces


		reindexFaces() {

			const activeFaces = [];

			for ( let i = 0; i < this.faces.length; i ++ ) {

				const face = this.faces[ i ];

				if ( face.mark === Visible ) {

					activeFaces.push( face );

				}

			}

			this.faces = activeFaces;
			return this;

		} // Finds the next vertex to create faces with the current hull


		nextVertexToAdd() {

			// if the 'assigned' list of vertices is empty, no vertices are left. return with 'undefined'
			if ( this.assigned.isEmpty() === false ) {

				let eyeVertex,
					maxDistance = 0; // grap the first available face and start with the first visible vertex of that face

				const eyeFace = this.assigned.first().face;
				let vertex = eyeFace.outside; // now calculate the farthest vertex that face can see

				do {

					const distance = eyeFace.distanceToPoint( vertex.point );

					if ( distance > maxDistance ) {

						maxDistance = distance;
						eyeVertex = vertex;

					}

					vertex = vertex.next;

				} while ( vertex !== null && vertex.face === eyeFace );

				return eyeVertex;

			}

		} // Computes a chain of half edges in CCW order called the 'horizon'.
		// For an edge to be part of the horizon it must join a face that can see
		// 'eyePoint' and a face that cannot see 'eyePoint'.


		computeHorizon( eyePoint, crossEdge, face, horizon ) {

			// moves face's vertices to the 'unassigned' vertex list
			this.deleteFaceVertices( face );
			face.mark = Deleted;
			let edge;

			if ( crossEdge === null ) {

				edge = crossEdge = face.getEdge( 0 );

			} else {

				// start from the next edge since 'crossEdge' was already analyzed
				// (actually 'crossEdge.twin' was the edge who called this method recursively)
				edge = crossEdge.next;

			}

			do {

				const twinEdge = edge.twin;
				const oppositeFace = twinEdge.face;

				if ( oppositeFace.mark === Visible ) {

					if ( oppositeFace.distanceToPoint( eyePoint ) > this.tolerance ) {

						// the opposite face can see the vertex, so proceed with next edge
						this.computeHorizon( eyePoint, twinEdge, oppositeFace, horizon );

					} else {

						// the opposite face can't see the vertex, so this edge is part of the horizon
						horizon.push( edge );

					}

				}

				edge = edge.next;

			} while ( edge !== crossEdge );

			return this;

		} // Creates a face with the vertices 'eyeVertex.point', 'horizonEdge.tail' and 'horizonEdge.head' in CCW order


		addAdjoiningFace( eyeVertex, horizonEdge ) {

			// all the half edges are created in ccw order thus the face is always pointing outside the hull
			const face = Face.create( eyeVertex, horizonEdge.tail(), horizonEdge.head() );
			this.faces.push( face ); // join face.getEdge( - 1 ) with the horizon's opposite edge face.getEdge( - 1 ) = face.getEdge( 2 )

			face.getEdge( - 1 ).setTwin( horizonEdge.twin );
			return face.getEdge( 0 ); // the half edge whose vertex is the eyeVertex

		} //  Adds 'horizon.length' faces to the hull, each face will be linked with the
		//  horizon opposite face and the face on the left/right


		addNewFaces( eyeVertex, horizon ) {

			this.newFaces = [];
			let firstSideEdge = null;
			let previousSideEdge = null;

			for ( let i = 0; i < horizon.length; i ++ ) {

				const horizonEdge = horizon[ i ]; // returns the right side edge

				const sideEdge = this.addAdjoiningFace( eyeVertex, horizonEdge );

				if ( firstSideEdge === null ) {

					firstSideEdge = sideEdge;

				} else {

					// joins face.getEdge( 1 ) with previousFace.getEdge( 0 )
					sideEdge.next.setTwin( previousSideEdge );

				}

				this.newFaces.push( sideEdge.face );
				previousSideEdge = sideEdge;

			} // perform final join of new faces


			firstSideEdge.next.setTwin( previousSideEdge );
			return this;

		} // Adds a vertex to the hull


		addVertexToHull( eyeVertex ) {

			const horizon = [];
			this.unassigned.clear(); // remove 'eyeVertex' from 'eyeVertex.face' so that it can't be added to the 'unassigned' vertex list

			this.removeVertexFromFace( eyeVertex, eyeVertex.face );
			this.computeHorizon( eyeVertex.point, null, eyeVertex.face, horizon );
			this.addNewFaces( eyeVertex, horizon ); // reassign 'unassigned' vertices to the new faces

			this.resolveUnassignedPoints( this.newFaces );
			return this;

		}

		cleanup() {

			this.assigned.clear();
			this.unassigned.clear();
			this.newFaces = [];
			return this;

		}

		compute() {

			let vertex;
			this.computeInitialHull(); // add all available vertices gradually to the hull

			while ( ( vertex = this.nextVertexToAdd() ) !== undefined ) {

				this.addVertexToHull( vertex );

			}

			this.reindexFaces();
			this.cleanup();
			return this;

		}

	} //


	class Face {

		constructor() {

			this.normal = new THREE.Vector3();
			this.midpoint = new THREE.Vector3();
			this.area = 0;
			this.constant = 0; // signed distance from face to the origin

			this.outside = null; // reference to a vertex in a vertex list this face can see

			this.mark = Visible;
			this.edge = null;

		}

		static create( a, b, c ) {

			const face = new Face();
			const e0 = new HalfEdge( a, face );
			const e1 = new HalfEdge( b, face );
			const e2 = new HalfEdge( c, face ); // join edges

			e0.next = e2.prev = e1;
			e1.next = e0.prev = e2;
			e2.next = e1.prev = e0; // main half edge reference

			face.edge = e0;
			return face.compute();

		}

		getEdge( i ) {

			let edge = this.edge;

			while ( i > 0 ) {

				edge = edge.next;
				i --;

			}

			while ( i < 0 ) {

				edge = edge.prev;
				i ++;

			}

			return edge;

		}

		compute() {

			const a = this.edge.tail();
			const b = this.edge.head();
			const c = this.edge.next.head();

			_triangle.set( a.point, b.point, c.point );

			_triangle.getNormal( this.normal );

			_triangle.getMidpoint( this.midpoint );

			this.area = _triangle.getArea();
			this.constant = this.normal.dot( this.midpoint );
			return this;

		}

		distanceToPoint( point ) {

			return this.normal.dot( point ) - this.constant;

		}

	} // Entity for a Doubly-Connected Edge List (DCEL).


	class HalfEdge {

		constructor( vertex, face ) {

			this.vertex = vertex;
			this.prev = null;
			this.next = null;
			this.twin = null;
			this.face = face;

		}

		head() {

			return this.vertex;

		}

		tail() {

			return this.prev ? this.prev.vertex : null;

		}

		length() {

			const head = this.head();
			const tail = this.tail();

			if ( tail !== null ) {

				return tail.point.distanceTo( head.point );

			}

			return - 1;

		}

		lengthSquared() {

			const head = this.head();
			const tail = this.tail();

			if ( tail !== null ) {

				return tail.point.distanceToSquared( head.point );

			}

			return - 1;

		}

		setTwin( edge ) {

			this.twin = edge;
			edge.twin = this;
			return this;

		}

	} // A vertex as a double linked list node.


	class VertexNode {

		constructor( point ) {

			this.point = point;
			this.prev = null;
			this.next = null;
			this.face = null; // the face that is able to see this vertex

		}

	} // A double linked list that contains vertex nodes.


	class VertexList {

		constructor() {

			this.head = null;
			this.tail = null;

		}

		first() {

			return this.head;

		}

		last() {

			return this.tail;

		}

		clear() {

			this.head = this.tail = null;
			return this;

		} // Inserts a vertex before the target vertex


		insertBefore( target, vertex ) {

			vertex.prev = target.prev;
			vertex.next = target;

			if ( vertex.prev === null ) {

				this.head = vertex;

			} else {

				vertex.prev.next = vertex;

			}

			target.prev = vertex;
			return this;

		} // Inserts a vertex after the target vertex


		insertAfter( target, vertex ) {

			vertex.prev = target;
			vertex.next = target.next;

			if ( vertex.next === null ) {

				this.tail = vertex;

			} else {

				vertex.next.prev = vertex;

			}

			target.next = vertex;
			return this;

		} // Appends a vertex to the end of the linked list


		append( vertex ) {

			if ( this.head === null ) {

				this.head = vertex;

			} else {

				this.tail.next = vertex;

			}

			vertex.prev = this.tail;
			vertex.next = null; // the tail has no subsequent vertex

			this.tail = vertex;
			return this;

		} // Appends a chain of vertices where 'vertex' is the head.


		appendChain( vertex ) {

			if ( this.head === null ) {

				this.head = vertex;

			} else {

				this.tail.next = vertex;

			}

			vertex.prev = this.tail; // ensure that the 'tail' reference points to the last vertex of the chain

			while ( vertex.next !== null ) {

				vertex = vertex.next;

			}

			this.tail = vertex;
			return this;

		} // Removes a vertex from the linked list


		remove( vertex ) {

			if ( vertex.prev === null ) {

				this.head = vertex.next;

			} else {

				vertex.prev.next = vertex.next;

			}

			if ( vertex.next === null ) {

				this.tail = vertex.prev;

			} else {

				vertex.next.prev = vertex.prev;

			}

			return this;

		} // Removes a list of vertices whose 'head' is 'a' and whose 'tail' is b


		removeSubList( a, b ) {

			if ( a.prev === null ) {

				this.head = b.next;

			} else {

				a.prev.next = b.next;

			}

			if ( b.next === null ) {

				this.tail = a.prev;

			} else {

				b.next.prev = a.prev;

			}

			return this;

		}

		isEmpty() {

			return this.head === null;

		}

	}

	THREE.ConvexHull = ConvexHull;

} )();

/* --- three/examples/js/math/SimplexNoise.js --- */
( function () {

	// Ported from Stefan Gustavson's java implementation
	// http://staffwww.itn.liu.se/~stegu/simplexnoise/simplexnoise.pdf
	// Read Stefan's excellent paper for details on how this code works.
	//
	// Sean McCullough banksean@gmail.com
	//
	// Added 4D noise

	/**
 * You can pass in a random number generator object if you like.
 * It is assumed to have a random() method.
 */
	class SimplexNoise {

		constructor( r = Math ) {

			this.grad3 = [[ 1, 1, 0 ], [ - 1, 1, 0 ], [ 1, - 1, 0 ], [ - 1, - 1, 0 ], [ 1, 0, 1 ], [ - 1, 0, 1 ], [ 1, 0, - 1 ], [ - 1, 0, - 1 ], [ 0, 1, 1 ], [ 0, - 1, 1 ], [ 0, 1, - 1 ], [ 0, - 1, - 1 ]];
			this.grad4 = [[ 0, 1, 1, 1 ], [ 0, 1, 1, - 1 ], [ 0, 1, - 1, 1 ], [ 0, 1, - 1, - 1 ], [ 0, - 1, 1, 1 ], [ 0, - 1, 1, - 1 ], [ 0, - 1, - 1, 1 ], [ 0, - 1, - 1, - 1 ], [ 1, 0, 1, 1 ], [ 1, 0, 1, - 1 ], [ 1, 0, - 1, 1 ], [ 1, 0, - 1, - 1 ], [ - 1, 0, 1, 1 ], [ - 1, 0, 1, - 1 ], [ - 1, 0, - 1, 1 ], [ - 1, 0, - 1, - 1 ], [ 1, 1, 0, 1 ], [ 1, 1, 0, - 1 ], [ 1, - 1, 0, 1 ], [ 1, - 1, 0, - 1 ], [ - 1, 1, 0, 1 ], [ - 1, 1, 0, - 1 ], [ - 1, - 1, 0, 1 ], [ - 1, - 1, 0, - 1 ], [ 1, 1, 1, 0 ], [ 1, 1, - 1, 0 ], [ 1, - 1, 1, 0 ], [ 1, - 1, - 1, 0 ], [ - 1, 1, 1, 0 ], [ - 1, 1, - 1, 0 ], [ - 1, - 1, 1, 0 ], [ - 1, - 1, - 1, 0 ]];
			this.p = [];

			for ( let i = 0; i < 256; i ++ ) {

				this.p[ i ] = Math.floor( r.random() * 256 );

			} // To remove the need for index wrapping, double the permutation table length


			this.perm = [];

			for ( let i = 0; i < 512; i ++ ) {

				this.perm[ i ] = this.p[ i & 255 ];

			} // A lookup table to traverse the simplex around a given point in 4D.
			// Details can be found where this table is used, in the 4D noise method.


			this.simplex = [[ 0, 1, 2, 3 ], [ 0, 1, 3, 2 ], [ 0, 0, 0, 0 ], [ 0, 2, 3, 1 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 1, 2, 3, 0 ], [ 0, 2, 1, 3 ], [ 0, 0, 0, 0 ], [ 0, 3, 1, 2 ], [ 0, 3, 2, 1 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 1, 3, 2, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 1, 2, 0, 3 ], [ 0, 0, 0, 0 ], [ 1, 3, 0, 2 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 2, 3, 0, 1 ], [ 2, 3, 1, 0 ], [ 1, 0, 2, 3 ], [ 1, 0, 3, 2 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 2, 0, 3, 1 ], [ 0, 0, 0, 0 ], [ 2, 1, 3, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 2, 0, 1, 3 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 3, 0, 1, 2 ], [ 3, 0, 2, 1 ], [ 0, 0, 0, 0 ], [ 3, 1, 2, 0 ], [ 2, 1, 0, 3 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ], [ 3, 1, 0, 2 ], [ 0, 0, 0, 0 ], [ 3, 2, 0, 1 ], [ 3, 2, 1, 0 ]];

		}

		dot( g, x, y ) {

			return g[ 0 ] * x + g[ 1 ] * y;

		}

		dot3( g, x, y, z ) {

			return g[ 0 ] * x + g[ 1 ] * y + g[ 2 ] * z;

		}

		dot4( g, x, y, z, w ) {

			return g[ 0 ] * x + g[ 1 ] * y + g[ 2 ] * z + g[ 3 ] * w;

		}

		noise( xin, yin ) {

			let n0; // Noise contributions from the three corners

			let n1;
			let n2; // Skew the input space to determine which simplex cell we're in

			const F2 = 0.5 * ( Math.sqrt( 3.0 ) - 1.0 );
			const s = ( xin + yin ) * F2; // Hairy factor for 2D

			const i = Math.floor( xin + s );
			const j = Math.floor( yin + s );
			const G2 = ( 3.0 - Math.sqrt( 3.0 ) ) / 6.0;
			const t = ( i + j ) * G2;
			const X0 = i - t; // Unskew the cell origin back to (x,y) space

			const Y0 = j - t;
			const x0 = xin - X0; // The x,y distances from the cell origin

			const y0 = yin - Y0; // For the 2D case, the simplex shape is an equilateral triangle.
			// Determine which simplex we are in.

			let i1; // Offsets for second (middle) corner of simplex in (i,j) coords

			let j1;

			if ( x0 > y0 ) {

				i1 = 1;
				j1 = 0; // lower triangle, XY order: (0,0)->(1,0)->(1,1)

			} else {

				i1 = 0;
				j1 = 1;

			} // upper triangle, YX order: (0,0)->(0,1)->(1,1)
			// A step of (1,0) in (i,j) means a step of (1-c,-c) in (x,y), and
			// a step of (0,1) in (i,j) means a step of (-c,1-c) in (x,y), where
			// c = (3-sqrt(3))/6


			const x1 = x0 - i1 + G2; // Offsets for middle corner in (x,y) unskewed coords

			const y1 = y0 - j1 + G2;
			const x2 = x0 - 1.0 + 2.0 * G2; // Offsets for last corner in (x,y) unskewed coords

			const y2 = y0 - 1.0 + 2.0 * G2; // Work out the hashed gradient indices of the three simplex corners

			const ii = i & 255;
			const jj = j & 255;
			const gi0 = this.perm[ ii + this.perm[ jj ] ] % 12;
			const gi1 = this.perm[ ii + i1 + this.perm[ jj + j1 ] ] % 12;
			const gi2 = this.perm[ ii + 1 + this.perm[ jj + 1 ] ] % 12; // Calculate the contribution from the three corners

			let t0 = 0.5 - x0 * x0 - y0 * y0;
			if ( t0 < 0 ) n0 = 0.0; else {

				t0 *= t0;
				n0 = t0 * t0 * this.dot( this.grad3[ gi0 ], x0, y0 ); // (x,y) of grad3 used for 2D gradient

			}

			let t1 = 0.5 - x1 * x1 - y1 * y1;
			if ( t1 < 0 ) n1 = 0.0; else {

				t1 *= t1;
				n1 = t1 * t1 * this.dot( this.grad3[ gi1 ], x1, y1 );

			}

			let t2 = 0.5 - x2 * x2 - y2 * y2;
			if ( t2 < 0 ) n2 = 0.0; else {

				t2 *= t2;
				n2 = t2 * t2 * this.dot( this.grad3[ gi2 ], x2, y2 );

			} // Add contributions from each corner to get the final noise value.
			// The result is scaled to return values in the interval [-1,1].

			return 70.0 * ( n0 + n1 + n2 );

		} // 3D simplex noise


		noise3d( xin, yin, zin ) {

			let n0; // Noise contributions from the four corners

			let n1;
			let n2;
			let n3; // Skew the input space to determine which simplex cell we're in

			const F3 = 1.0 / 3.0;
			const s = ( xin + yin + zin ) * F3; // Very nice and simple skew factor for 3D

			const i = Math.floor( xin + s );
			const j = Math.floor( yin + s );
			const k = Math.floor( zin + s );
			const G3 = 1.0 / 6.0; // Very nice and simple unskew factor, too

			const t = ( i + j + k ) * G3;
			const X0 = i - t; // Unskew the cell origin back to (x,y,z) space

			const Y0 = j - t;
			const Z0 = k - t;
			const x0 = xin - X0; // The x,y,z distances from the cell origin

			const y0 = yin - Y0;
			const z0 = zin - Z0; // For the 3D case, the simplex shape is a slightly irregular tetrahedron.
			// Determine which simplex we are in.

			let i1; // Offsets for second corner of simplex in (i,j,k) coords

			let j1;
			let k1;
			let i2; // Offsets for third corner of simplex in (i,j,k) coords

			let j2;
			let k2;

			if ( x0 >= y0 ) {

				if ( y0 >= z0 ) {

					i1 = 1;
					j1 = 0;
					k1 = 0;
					i2 = 1;
					j2 = 1;
					k2 = 0; // X Y Z order

				} else if ( x0 >= z0 ) {

					i1 = 1;
					j1 = 0;
					k1 = 0;
					i2 = 1;
					j2 = 0;
					k2 = 1; // X Z Y order

				} else {

					i1 = 0;
					j1 = 0;
					k1 = 1;
					i2 = 1;
					j2 = 0;
					k2 = 1;

				} // Z X Y order

			} else {

				// x0<y0
				if ( y0 < z0 ) {

					i1 = 0;
					j1 = 0;
					k1 = 1;
					i2 = 0;
					j2 = 1;
					k2 = 1; // Z Y X order

				} else if ( x0 < z0 ) {

					i1 = 0;
					j1 = 1;
					k1 = 0;
					i2 = 0;
					j2 = 1;
					k2 = 1; // Y Z X order

				} else {

					i1 = 0;
					j1 = 1;
					k1 = 0;
					i2 = 1;
					j2 = 1;
					k2 = 0;

				} // Y X Z order

			} // A step of (1,0,0) in (i,j,k) means a step of (1-c,-c,-c) in (x,y,z),
			// a step of (0,1,0) in (i,j,k) means a step of (-c,1-c,-c) in (x,y,z), and
			// a step of (0,0,1) in (i,j,k) means a step of (-c,-c,1-c) in (x,y,z), where
			// c = 1/6.


			const x1 = x0 - i1 + G3; // Offsets for second corner in (x,y,z) coords

			const y1 = y0 - j1 + G3;
			const z1 = z0 - k1 + G3;
			const x2 = x0 - i2 + 2.0 * G3; // Offsets for third corner in (x,y,z) coords

			const y2 = y0 - j2 + 2.0 * G3;
			const z2 = z0 - k2 + 2.0 * G3;
			const x3 = x0 - 1.0 + 3.0 * G3; // Offsets for last corner in (x,y,z) coords

			const y3 = y0 - 1.0 + 3.0 * G3;
			const z3 = z0 - 1.0 + 3.0 * G3; // Work out the hashed gradient indices of the four simplex corners

			const ii = i & 255;
			const jj = j & 255;
			const kk = k & 255;
			const gi0 = this.perm[ ii + this.perm[ jj + this.perm[ kk ] ] ] % 12;
			const gi1 = this.perm[ ii + i1 + this.perm[ jj + j1 + this.perm[ kk + k1 ] ] ] % 12;
			const gi2 = this.perm[ ii + i2 + this.perm[ jj + j2 + this.perm[ kk + k2 ] ] ] % 12;
			const gi3 = this.perm[ ii + 1 + this.perm[ jj + 1 + this.perm[ kk + 1 ] ] ] % 12; // Calculate the contribution from the four corners

			let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
			if ( t0 < 0 ) n0 = 0.0; else {

				t0 *= t0;
				n0 = t0 * t0 * this.dot3( this.grad3[ gi0 ], x0, y0, z0 );

			}

			let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
			if ( t1 < 0 ) n1 = 0.0; else {

				t1 *= t1;
				n1 = t1 * t1 * this.dot3( this.grad3[ gi1 ], x1, y1, z1 );

			}

			let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
			if ( t2 < 0 ) n2 = 0.0; else {

				t2 *= t2;
				n2 = t2 * t2 * this.dot3( this.grad3[ gi2 ], x2, y2, z2 );

			}

			let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
			if ( t3 < 0 ) n3 = 0.0; else {

				t3 *= t3;
				n3 = t3 * t3 * this.dot3( this.grad3[ gi3 ], x3, y3, z3 );

			} // Add contributions from each corner to get the final noise value.
			// The result is scaled to stay just inside [-1,1]

			return 32.0 * ( n0 + n1 + n2 + n3 );

		} // 4D simplex noise


		noise4d( x, y, z, w ) {

			// For faster and easier lookups
			const grad4 = this.grad4;
			const simplex = this.simplex;
			const perm = this.perm; // The skewing and unskewing factors are hairy again for the 4D case

			const F4 = ( Math.sqrt( 5.0 ) - 1.0 ) / 4.0;
			const G4 = ( 5.0 - Math.sqrt( 5.0 ) ) / 20.0;
			let n0; // Noise contributions from the five corners

			let n1;
			let n2;
			let n3;
			let n4; // Skew the (x,y,z,w) space to determine which cell of 24 simplices we're in

			const s = ( x + y + z + w ) * F4; // Factor for 4D skewing

			const i = Math.floor( x + s );
			const j = Math.floor( y + s );
			const k = Math.floor( z + s );
			const l = Math.floor( w + s );
			const t = ( i + j + k + l ) * G4; // Factor for 4D unskewing

			const X0 = i - t; // Unskew the cell origin back to (x,y,z,w) space

			const Y0 = j - t;
			const Z0 = k - t;
			const W0 = l - t;
			const x0 = x - X0; // The x,y,z,w distances from the cell origin

			const y0 = y - Y0;
			const z0 = z - Z0;
			const w0 = w - W0; // For the 4D case, the simplex is a 4D shape I won't even try to describe.
			// To find out which of the 24 possible simplices we're in, we need to
			// determine the magnitude ordering of x0, y0, z0 and w0.
			// The method below is a good way of finding the ordering of x,y,z,w and
			// then find the correct traversal order for the simplex we’re in.
			// First, six pair-wise comparisons are performed between each possible pair
			// of the four coordinates, and the results are used to add up binary bits
			// for an integer index.

			const c1 = x0 > y0 ? 32 : 0;
			const c2 = x0 > z0 ? 16 : 0;
			const c3 = y0 > z0 ? 8 : 0;
			const c4 = x0 > w0 ? 4 : 0;
			const c5 = y0 > w0 ? 2 : 0;
			const c6 = z0 > w0 ? 1 : 0;
			const c = c1 + c2 + c3 + c4 + c5 + c6; // simplex[c] is a 4-vector with the numbers 0, 1, 2 and 3 in some order.
			// Many values of c will never occur, since e.g. x>y>z>w makes x<z, y<w and x<w
			// impossible. Only the 24 indices which have non-zero entries make any sense.
			// We use a thresholding to set the coordinates in turn from the largest magnitude.
			// The number 3 in the "simplex" array is at the position of the largest coordinate.

			const i1 = simplex[ c ][ 0 ] >= 3 ? 1 : 0;
			const j1 = simplex[ c ][ 1 ] >= 3 ? 1 : 0;
			const k1 = simplex[ c ][ 2 ] >= 3 ? 1 : 0;
			const l1 = simplex[ c ][ 3 ] >= 3 ? 1 : 0; // The number 2 in the "simplex" array is at the second largest coordinate.

			const i2 = simplex[ c ][ 0 ] >= 2 ? 1 : 0;
			const j2 = simplex[ c ][ 1 ] >= 2 ? 1 : 0;
			const k2 = simplex[ c ][ 2 ] >= 2 ? 1 : 0;
			const l2 = simplex[ c ][ 3 ] >= 2 ? 1 : 0; // The number 1 in the "simplex" array is at the second smallest coordinate.

			const i3 = simplex[ c ][ 0 ] >= 1 ? 1 : 0;
			const j3 = simplex[ c ][ 1 ] >= 1 ? 1 : 0;
			const k3 = simplex[ c ][ 2 ] >= 1 ? 1 : 0;
			const l3 = simplex[ c ][ 3 ] >= 1 ? 1 : 0; // The fifth corner has all coordinate offsets = 1, so no need to look that up.

			const x1 = x0 - i1 + G4; // Offsets for second corner in (x,y,z,w) coords

			const y1 = y0 - j1 + G4;
			const z1 = z0 - k1 + G4;
			const w1 = w0 - l1 + G4;
			const x2 = x0 - i2 + 2.0 * G4; // Offsets for third corner in (x,y,z,w) coords

			const y2 = y0 - j2 + 2.0 * G4;
			const z2 = z0 - k2 + 2.0 * G4;
			const w2 = w0 - l2 + 2.0 * G4;
			const x3 = x0 - i3 + 3.0 * G4; // Offsets for fourth corner in (x,y,z,w) coords

			const y3 = y0 - j3 + 3.0 * G4;
			const z3 = z0 - k3 + 3.0 * G4;
			const w3 = w0 - l3 + 3.0 * G4;
			const x4 = x0 - 1.0 + 4.0 * G4; // Offsets for last corner in (x,y,z,w) coords

			const y4 = y0 - 1.0 + 4.0 * G4;
			const z4 = z0 - 1.0 + 4.0 * G4;
			const w4 = w0 - 1.0 + 4.0 * G4; // Work out the hashed gradient indices of the five simplex corners

			const ii = i & 255;
			const jj = j & 255;
			const kk = k & 255;
			const ll = l & 255;
			const gi0 = perm[ ii + perm[ jj + perm[ kk + perm[ ll ] ] ] ] % 32;
			const gi1 = perm[ ii + i1 + perm[ jj + j1 + perm[ kk + k1 + perm[ ll + l1 ] ] ] ] % 32;
			const gi2 = perm[ ii + i2 + perm[ jj + j2 + perm[ kk + k2 + perm[ ll + l2 ] ] ] ] % 32;
			const gi3 = perm[ ii + i3 + perm[ jj + j3 + perm[ kk + k3 + perm[ ll + l3 ] ] ] ] % 32;
			const gi4 = perm[ ii + 1 + perm[ jj + 1 + perm[ kk + 1 + perm[ ll + 1 ] ] ] ] % 32; // Calculate the contribution from the five corners

			let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
			if ( t0 < 0 ) n0 = 0.0; else {

				t0 *= t0;
				n0 = t0 * t0 * this.dot4( grad4[ gi0 ], x0, y0, z0, w0 );

			}

			let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
			if ( t1 < 0 ) n1 = 0.0; else {

				t1 *= t1;
				n1 = t1 * t1 * this.dot4( grad4[ gi1 ], x1, y1, z1, w1 );

			}

			let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
			if ( t2 < 0 ) n2 = 0.0; else {

				t2 *= t2;
				n2 = t2 * t2 * this.dot4( grad4[ gi2 ], x2, y2, z2, w2 );

			}

			let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
			if ( t3 < 0 ) n3 = 0.0; else {

				t3 *= t3;
				n3 = t3 * t3 * this.dot4( grad4[ gi3 ], x3, y3, z3, w3 );

			}

			let t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
			if ( t4 < 0 ) n4 = 0.0; else {

				t4 *= t4;
				n4 = t4 * t4 * this.dot4( grad4[ gi4 ], x4, y4, z4, w4 );

			} // Sum up and scale the result to cover the range [-1,1]

			return 27.0 * ( n0 + n1 + n2 + n3 + n4 );

		}

	}

	THREE.SimplexNoise = SimplexNoise;

} )();

/* --- three/examples/js/math/ImprovedNoise.js --- */
( function () {

	// http://mrl.nyu.edu/~perlin/noise/
	const _p = [ 151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180 ];

	for ( let i = 0; i < 256; i ++ ) {

		_p[ 256 + i ] = _p[ i ];

	}

	function fade( t ) {

		return t * t * t * ( t * ( t * 6 - 15 ) + 10 );

	}

	function lerp( t, a, b ) {

		return a + t * ( b - a );

	}

	function grad( hash, x, y, z ) {

		const h = hash & 15;
		const u = h < 8 ? x : y,
			v = h < 4 ? y : h == 12 || h == 14 ? x : z;
		return ( ( h & 1 ) == 0 ? u : - u ) + ( ( h & 2 ) == 0 ? v : - v );

	}

	class ImprovedNoise {

		noise( x, y, z ) {

			const floorX = Math.floor( x ),
				floorY = Math.floor( y ),
				floorZ = Math.floor( z );
			const X = floorX & 255,
				Y = floorY & 255,
				Z = floorZ & 255;
			x -= floorX;
			y -= floorY;
			z -= floorZ;
			const xMinus1 = x - 1,
				yMinus1 = y - 1,
				zMinus1 = z - 1;
			const u = fade( x ),
				v = fade( y ),
				w = fade( z );
			const A = _p[ X ] + Y,
				AA = _p[ A ] + Z,
				AB = _p[ A + 1 ] + Z,
				B = _p[ X + 1 ] + Y,
				BA = _p[ B ] + Z,
				BB = _p[ B + 1 ] + Z;
			return lerp( w, lerp( v, lerp( u, grad( _p[ AA ], x, y, z ), grad( _p[ BA ], xMinus1, y, z ) ), lerp( u, grad( _p[ AB ], x, yMinus1, z ), grad( _p[ BB ], xMinus1, yMinus1, z ) ) ), lerp( v, lerp( u, grad( _p[ AA + 1 ], x, y, zMinus1 ), grad( _p[ BA + 1 ], xMinus1, y, zMinus1 ) ), lerp( u, grad( _p[ AB + 1 ], x, yMinus1, zMinus1 ), grad( _p[ BB + 1 ], xMinus1, yMinus1, zMinus1 ) ) ) );

		}

	}

	THREE.ImprovedNoise = ImprovedNoise;

} )();

/* --- three/examples/js/math/MeshSurfaceSampler.js --- */
( function () {

	/**
 * Utility class for sampling weighted random points on the surface of a mesh.
 *
 * Building the sampler is a one-time O(n) operation. Once built, any number of
 * random samples may be selected in O(logn) time. Memory usage is O(n).
 *
 * References:
 * - http://www.joesfer.com/?p=84
 * - https://stackoverflow.com/a/4322940/1314762
 */

	const _face = new THREE.Triangle();

	const _color = new THREE.Vector3();

	class MeshSurfaceSampler {

		constructor( mesh ) {

			let geometry = mesh.geometry;

			if ( ! geometry.isBufferGeometry || geometry.attributes.position.itemSize !== 3 ) {

				throw new Error( 'THREE.MeshSurfaceSampler: Requires BufferGeometry triangle mesh.' );

			}

			if ( geometry.index ) {

				console.warn( 'THREE.MeshSurfaceSampler: Converting geometry to non-indexed BufferGeometry.' );
				geometry = geometry.toNonIndexed();

			}

			this.geometry = geometry;
			this.randomFunction = Math.random;
			this.positionAttribute = this.geometry.getAttribute( 'position' );
			this.colorAttribute = this.geometry.getAttribute( 'color' );
			this.weightAttribute = null;
			this.distribution = null;

		}

		setWeightAttribute( name ) {

			this.weightAttribute = name ? this.geometry.getAttribute( name ) : null;
			return this;

		}

		build() {

			const positionAttribute = this.positionAttribute;
			const weightAttribute = this.weightAttribute;
			const faceWeights = new Float32Array( positionAttribute.count / 3 ); // Accumulate weights for each mesh face.

			for ( let i = 0; i < positionAttribute.count; i += 3 ) {

				let faceWeight = 1;

				if ( weightAttribute ) {

					faceWeight = weightAttribute.getX( i ) + weightAttribute.getX( i + 1 ) + weightAttribute.getX( i + 2 );

				}

				_face.a.fromBufferAttribute( positionAttribute, i );

				_face.b.fromBufferAttribute( positionAttribute, i + 1 );

				_face.c.fromBufferAttribute( positionAttribute, i + 2 );

				faceWeight *= _face.getArea();
				faceWeights[ i / 3 ] = faceWeight;

			} // Store cumulative total face weights in an array, where weight index
			// corresponds to face index.


			this.distribution = new Float32Array( positionAttribute.count / 3 );
			let cumulativeTotal = 0;

			for ( let i = 0; i < faceWeights.length; i ++ ) {

				cumulativeTotal += faceWeights[ i ];
				this.distribution[ i ] = cumulativeTotal;

			}

			return this;

		}

		setRandomGenerator( randomFunction ) {

			this.randomFunction = randomFunction;
			return this;

		}

		sample( targetPosition, targetNormal, targetColor ) {

			const cumulativeTotal = this.distribution[ this.distribution.length - 1 ];
			const faceIndex = this.binarySearch( this.randomFunction() * cumulativeTotal );
			return this.sampleFace( faceIndex, targetPosition, targetNormal, targetColor );

		}

		binarySearch( x ) {

			const dist = this.distribution;
			let start = 0;
			let end = dist.length - 1;
			let index = - 1;

			while ( start <= end ) {

				const mid = Math.ceil( ( start + end ) / 2 );

				if ( mid === 0 || dist[ mid - 1 ] <= x && dist[ mid ] > x ) {

					index = mid;
					break;

				} else if ( x < dist[ mid ] ) {

					end = mid - 1;

				} else {

					start = mid + 1;

				}

			}

			return index;

		}

		sampleFace( faceIndex, targetPosition, targetNormal, targetColor ) {

			let u = this.randomFunction();
			let v = this.randomFunction();

			if ( u + v > 1 ) {

				u = 1 - u;
				v = 1 - v;

			}

			_face.a.fromBufferAttribute( this.positionAttribute, faceIndex * 3 );

			_face.b.fromBufferAttribute( this.positionAttribute, faceIndex * 3 + 1 );

			_face.c.fromBufferAttribute( this.positionAttribute, faceIndex * 3 + 2 );

			targetPosition.set( 0, 0, 0 ).addScaledVector( _face.a, u ).addScaledVector( _face.b, v ).addScaledVector( _face.c, 1 - ( u + v ) );

			if ( targetNormal !== undefined ) {

				_face.getNormal( targetNormal );

			}

			if ( targetColor !== undefined && this.colorAttribute !== undefined ) {

				_face.a.fromBufferAttribute( this.colorAttribute, faceIndex * 3 );

				_face.b.fromBufferAttribute( this.colorAttribute, faceIndex * 3 + 1 );

				_face.c.fromBufferAttribute( this.colorAttribute, faceIndex * 3 + 2 );

				_color.set( 0, 0, 0 ).addScaledVector( _face.a, u ).addScaledVector( _face.b, v ).addScaledVector( _face.c, 1 - ( u + v ) );

				targetColor.r = _color.x;
				targetColor.g = _color.y;
				targetColor.b = _color.z;

			}

			return this;

		}

	}

	THREE.MeshSurfaceSampler = MeshSurfaceSampler;

} )();

/* --- three/examples/js/math/OBB.js --- */
( function () {

	const a = {
		c: null,
		// center
		u: [ new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3() ],
		// basis vectors
		e: [] // half width

	};
	const b = {
		c: null,
		// center
		u: [ new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3() ],
		// basis vectors
		e: [] // half width

	};
	const R = [[], [], []];
	const AbsR = [[], [], []];
	const t = [];
	const xAxis = new THREE.Vector3();
	const yAxis = new THREE.Vector3();
	const zAxis = new THREE.Vector3();
	const v1 = new THREE.Vector3();
	const size = new THREE.Vector3();
	const closestPoint = new THREE.Vector3();
	const rotationMatrix = new THREE.Matrix3();
	const aabb = new THREE.Box3();
	const matrix = new THREE.Matrix4();
	const inverse = new THREE.Matrix4();
	const localRay = new THREE.Ray(); // OBB

	class OBB {

		constructor( center = new THREE.Vector3(), halfSize = new THREE.Vector3(), rotation = new THREE.Matrix3() ) {

			this.center = center;
			this.halfSize = halfSize;
			this.rotation = rotation;

		}

		set( center, halfSize, rotation ) {

			this.center = center;
			this.halfSize = halfSize;
			this.rotation = rotation;
			return this;

		}

		copy( obb ) {

			this.center.copy( obb.center );
			this.halfSize.copy( obb.halfSize );
			this.rotation.copy( obb.rotation );
			return this;

		}

		clone() {

			return new this.constructor().copy( this );

		}

		getSize( result ) {

			return result.copy( this.halfSize ).multiplyScalar( 2 );

		}
		/**
  * Reference: Closest Point on OBB to Point in Real-Time Collision Detection
  * by Christer Ericson (chapter 5.1.4)
  */


		clampPoint( point, result ) {

			const halfSize = this.halfSize;
			v1.subVectors( point, this.center );
			this.rotation.extractBasis( xAxis, yAxis, zAxis ); // start at the center position of the OBB

			result.copy( this.center ); // project the target onto the OBB axes and walk towards that point

			const x = THREE.MathUtils.clamp( v1.dot( xAxis ), - halfSize.x, halfSize.x );
			result.add( xAxis.multiplyScalar( x ) );
			const y = THREE.MathUtils.clamp( v1.dot( yAxis ), - halfSize.y, halfSize.y );
			result.add( yAxis.multiplyScalar( y ) );
			const z = THREE.MathUtils.clamp( v1.dot( zAxis ), - halfSize.z, halfSize.z );
			result.add( zAxis.multiplyScalar( z ) );
			return result;

		}

		containsPoint( point ) {

			v1.subVectors( point, this.center );
			this.rotation.extractBasis( xAxis, yAxis, zAxis ); // project v1 onto each axis and check if these points lie inside the OBB

			return Math.abs( v1.dot( xAxis ) ) <= this.halfSize.x && Math.abs( v1.dot( yAxis ) ) <= this.halfSize.y && Math.abs( v1.dot( zAxis ) ) <= this.halfSize.z;

		}

		intersectsBox3( box3 ) {

			return this.intersectsOBB( obb.fromBox3( box3 ) );

		}

		intersectsSphere( sphere ) {

			// find the point on the OBB closest to the sphere center
			this.clampPoint( sphere.center, closestPoint ); // if that point is inside the sphere, the OBB and sphere intersect

			return closestPoint.distanceToSquared( sphere.center ) <= sphere.radius * sphere.radius;

		}
		/**
  * Reference: OBB-OBB Intersection in Real-Time Collision Detection
  * by Christer Ericson (chapter 4.4.1)
  *
  */


		intersectsOBB( obb, epsilon = Number.EPSILON ) {

			// prepare data structures (the code uses the same nomenclature like the reference)
			a.c = this.center;
			a.e[ 0 ] = this.halfSize.x;
			a.e[ 1 ] = this.halfSize.y;
			a.e[ 2 ] = this.halfSize.z;
			this.rotation.extractBasis( a.u[ 0 ], a.u[ 1 ], a.u[ 2 ] );
			b.c = obb.center;
			b.e[ 0 ] = obb.halfSize.x;
			b.e[ 1 ] = obb.halfSize.y;
			b.e[ 2 ] = obb.halfSize.z;
			obb.rotation.extractBasis( b.u[ 0 ], b.u[ 1 ], b.u[ 2 ] ); // compute rotation matrix expressing b in a's coordinate frame

			for ( let i = 0; i < 3; i ++ ) {

				for ( let j = 0; j < 3; j ++ ) {

					R[ i ][ j ] = a.u[ i ].dot( b.u[ j ] );

				}

			} // compute translation vector


			v1.subVectors( b.c, a.c ); // bring translation into a's coordinate frame

			t[ 0 ] = v1.dot( a.u[ 0 ] );
			t[ 1 ] = v1.dot( a.u[ 1 ] );
			t[ 2 ] = v1.dot( a.u[ 2 ] ); // compute common subexpressions. Add in an epsilon term to
			// counteract arithmetic errors when two edges are parallel and
			// their cross product is (near) null

			for ( let i = 0; i < 3; i ++ ) {

				for ( let j = 0; j < 3; j ++ ) {

					AbsR[ i ][ j ] = Math.abs( R[ i ][ j ] ) + epsilon;

				}

			}

			let ra, rb; // test axes L = A0, L = A1, L = A2

			for ( let i = 0; i < 3; i ++ ) {

				ra = a.e[ i ];
				rb = b.e[ 0 ] * AbsR[ i ][ 0 ] + b.e[ 1 ] * AbsR[ i ][ 1 ] + b.e[ 2 ] * AbsR[ i ][ 2 ];
				if ( Math.abs( t[ i ] ) > ra + rb ) return false;

			} // test axes L = B0, L = B1, L = B2


			for ( let i = 0; i < 3; i ++ ) {

				ra = a.e[ 0 ] * AbsR[ 0 ][ i ] + a.e[ 1 ] * AbsR[ 1 ][ i ] + a.e[ 2 ] * AbsR[ 2 ][ i ];
				rb = b.e[ i ];
				if ( Math.abs( t[ 0 ] * R[ 0 ][ i ] + t[ 1 ] * R[ 1 ][ i ] + t[ 2 ] * R[ 2 ][ i ] ) > ra + rb ) return false;

			} // test axis L = A0 x B0


			ra = a.e[ 1 ] * AbsR[ 2 ][ 0 ] + a.e[ 2 ] * AbsR[ 1 ][ 0 ];
			rb = b.e[ 1 ] * AbsR[ 0 ][ 2 ] + b.e[ 2 ] * AbsR[ 0 ][ 1 ];
			if ( Math.abs( t[ 2 ] * R[ 1 ][ 0 ] - t[ 1 ] * R[ 2 ][ 0 ] ) > ra + rb ) return false; // test axis L = A0 x B1

			ra = a.e[ 1 ] * AbsR[ 2 ][ 1 ] + a.e[ 2 ] * AbsR[ 1 ][ 1 ];
			rb = b.e[ 0 ] * AbsR[ 0 ][ 2 ] + b.e[ 2 ] * AbsR[ 0 ][ 0 ];
			if ( Math.abs( t[ 2 ] * R[ 1 ][ 1 ] - t[ 1 ] * R[ 2 ][ 1 ] ) > ra + rb ) return false; // test axis L = A0 x B2

			ra = a.e[ 1 ] * AbsR[ 2 ][ 2 ] + a.e[ 2 ] * AbsR[ 1 ][ 2 ];
			rb = b.e[ 0 ] * AbsR[ 0 ][ 1 ] + b.e[ 1 ] * AbsR[ 0 ][ 0 ];
			if ( Math.abs( t[ 2 ] * R[ 1 ][ 2 ] - t[ 1 ] * R[ 2 ][ 2 ] ) > ra + rb ) return false; // test axis L = A1 x B0

			ra = a.e[ 0 ] * AbsR[ 2 ][ 0 ] + a.e[ 2 ] * AbsR[ 0 ][ 0 ];
			rb = b.e[ 1 ] * AbsR[ 1 ][ 2 ] + b.e[ 2 ] * AbsR[ 1 ][ 1 ];
			if ( Math.abs( t[ 0 ] * R[ 2 ][ 0 ] - t[ 2 ] * R[ 0 ][ 0 ] ) > ra + rb ) return false; // test axis L = A1 x B1

			ra = a.e[ 0 ] * AbsR[ 2 ][ 1 ] + a.e[ 2 ] * AbsR[ 0 ][ 1 ];
			rb = b.e[ 0 ] * AbsR[ 1 ][ 2 ] + b.e[ 2 ] * AbsR[ 1 ][ 0 ];
			if ( Math.abs( t[ 0 ] * R[ 2 ][ 1 ] - t[ 2 ] * R[ 0 ][ 1 ] ) > ra + rb ) return false; // test axis L = A1 x B2

			ra = a.e[ 0 ] * AbsR[ 2 ][ 2 ] + a.e[ 2 ] * AbsR[ 0 ][ 2 ];
			rb = b.e[ 0 ] * AbsR[ 1 ][ 1 ] + b.e[ 1 ] * AbsR[ 1 ][ 0 ];
			if ( Math.abs( t[ 0 ] * R[ 2 ][ 2 ] - t[ 2 ] * R[ 0 ][ 2 ] ) > ra + rb ) return false; // test axis L = A2 x B0

			ra = a.e[ 0 ] * AbsR[ 1 ][ 0 ] + a.e[ 1 ] * AbsR[ 0 ][ 0 ];
			rb = b.e[ 1 ] * AbsR[ 2 ][ 2 ] + b.e[ 2 ] * AbsR[ 2 ][ 1 ];
			if ( Math.abs( t[ 1 ] * R[ 0 ][ 0 ] - t[ 0 ] * R[ 1 ][ 0 ] ) > ra + rb ) return false; // test axis L = A2 x B1

			ra = a.e[ 0 ] * AbsR[ 1 ][ 1 ] + a.e[ 1 ] * AbsR[ 0 ][ 1 ];
			rb = b.e[ 0 ] * AbsR[ 2 ][ 2 ] + b.e[ 2 ] * AbsR[ 2 ][ 0 ];
			if ( Math.abs( t[ 1 ] * R[ 0 ][ 1 ] - t[ 0 ] * R[ 1 ][ 1 ] ) > ra + rb ) return false; // test axis L = A2 x B2

			ra = a.e[ 0 ] * AbsR[ 1 ][ 2 ] + a.e[ 1 ] * AbsR[ 0 ][ 2 ];
			rb = b.e[ 0 ] * AbsR[ 2 ][ 1 ] + b.e[ 1 ] * AbsR[ 2 ][ 0 ];
			if ( Math.abs( t[ 1 ] * R[ 0 ][ 2 ] - t[ 0 ] * R[ 1 ][ 2 ] ) > ra + rb ) return false; // since no separating axis is found, the OBBs must be intersecting

			return true;

		}
		/**
  * Reference: Testing Box Against Plane in Real-Time Collision Detection
  * by Christer Ericson (chapter 5.2.3)
  */


		intersectsPlane( plane ) {

			this.rotation.extractBasis( xAxis, yAxis, zAxis ); // compute the projection interval radius of this OBB onto L(t) = this->center + t * p.normal;

			const r = this.halfSize.x * Math.abs( plane.normal.dot( xAxis ) ) + this.halfSize.y * Math.abs( plane.normal.dot( yAxis ) ) + this.halfSize.z * Math.abs( plane.normal.dot( zAxis ) ); // compute distance of the OBB's center from the plane

			const d = plane.normal.dot( this.center ) - plane.constant; // Intersection occurs when distance d falls within [-r,+r] interval

			return Math.abs( d ) <= r;

		}
		/**
  * Performs a ray/OBB intersection test and stores the intersection point
  * to the given 3D vector. If no intersection is detected, *null* is returned.
  */


		intersectRay( ray, result ) {

			// the idea is to perform the intersection test in the local space
			// of the OBB.
			this.getSize( size );
			aabb.setFromCenterAndSize( v1.set( 0, 0, 0 ), size ); // create a 4x4 transformation matrix

			matrix.setFromMatrix3( this.rotation );
			matrix.setPosition( this.center ); // transform ray to the local space of the OBB

			inverse.copy( matrix ).invert();
			localRay.copy( ray ).applyMatrix4( inverse ); // perform ray <-> AABB intersection test

			if ( localRay.intersectBox( aabb, result ) ) {

				// transform the intersection point back to world space
				return result.applyMatrix4( matrix );

			} else {

				return null;

			}

		}
		/**
  * Performs a ray/OBB intersection test. Returns either true or false if
  * there is a intersection or not.
  */


		intersectsRay( ray ) {

			return this.intersectRay( ray, v1 ) !== null;

		}

		fromBox3( box3 ) {

			box3.getCenter( this.center );
			box3.getSize( this.halfSize ).multiplyScalar( 0.5 );
			this.rotation.identity();
			return this;

		}

		equals( obb ) {

			return obb.center.equals( this.center ) && obb.halfSize.equals( this.halfSize ) && obb.rotation.equals( this.rotation );

		}

		applyMatrix4( matrix ) {

			const e = matrix.elements;
			let sx = v1.set( e[ 0 ], e[ 1 ], e[ 2 ] ).length();
			const sy = v1.set( e[ 4 ], e[ 5 ], e[ 6 ] ).length();
			const sz = v1.set( e[ 8 ], e[ 9 ], e[ 10 ] ).length();
			const det = matrix.determinant();
			if ( det < 0 ) sx = - sx;
			rotationMatrix.setFromMatrix4( matrix );
			const invSX = 1 / sx;
			const invSY = 1 / sy;
			const invSZ = 1 / sz;
			rotationMatrix.elements[ 0 ] *= invSX;
			rotationMatrix.elements[ 1 ] *= invSX;
			rotationMatrix.elements[ 2 ] *= invSX;
			rotationMatrix.elements[ 3 ] *= invSY;
			rotationMatrix.elements[ 4 ] *= invSY;
			rotationMatrix.elements[ 5 ] *= invSY;
			rotationMatrix.elements[ 6 ] *= invSZ;
			rotationMatrix.elements[ 7 ] *= invSZ;
			rotationMatrix.elements[ 8 ] *= invSZ;
			this.rotation.multiply( rotationMatrix );
			this.halfSize.x *= sx;
			this.halfSize.y *= sy;
			this.halfSize.z *= sz;
			v1.setFromMatrixPosition( matrix );
			this.center.add( v1 );
			return this;

		}

	}

	const obb = new OBB();

	THREE.OBB = OBB;

} )();

/* --- three/examples/js/math/Capsule.js --- */
( function () {

	const _v1 = new THREE.Vector3();

	const _v2 = new THREE.Vector3();

	const _v3 = new THREE.Vector3();

	const EPS = 1e-10;

	class Capsule {

		constructor( start = new THREE.Vector3( 0, 0, 0 ), end = new THREE.Vector3( 0, 1, 0 ), radius = 1 ) {

			this.start = start;
			this.end = end;
			this.radius = radius;

		}

		clone() {

			return new Capsule( this.start.clone(), this.end.clone(), this.radius );

		}

		set( start, end, radius ) {

			this.start.copy( start );
			this.end.copy( end );
			this.radius = radius;

		}

		copy( capsule ) {

			this.start.copy( capsule.start );
			this.end.copy( capsule.end );
			this.radius = capsule.radius;

		}

		getCenter( target ) {

			return target.copy( this.end ).add( this.start ).multiplyScalar( 0.5 );

		}

		translate( v ) {

			this.start.add( v );
			this.end.add( v );

		}

		checkAABBAxis( p1x, p1y, p2x, p2y, minx, maxx, miny, maxy, radius ) {

			return ( minx - p1x < radius || minx - p2x < radius ) && ( p1x - maxx < radius || p2x - maxx < radius ) && ( miny - p1y < radius || miny - p2y < radius ) && ( p1y - maxy < radius || p2y - maxy < radius );

		}

		intersectsBox( box ) {

			return this.checkAABBAxis( this.start.x, this.start.y, this.end.x, this.end.y, box.min.x, box.max.x, box.min.y, box.max.y, this.radius ) && this.checkAABBAxis( this.start.x, this.start.z, this.end.x, this.end.z, box.min.x, box.max.x, box.min.z, box.max.z, this.radius ) && this.checkAABBAxis( this.start.y, this.start.z, this.end.y, this.end.z, box.min.y, box.max.y, box.min.z, box.max.z, this.radius );

		}

		lineLineMinimumPoints( line1, line2 ) {

			const r = _v1.copy( line1.end ).sub( line1.start );

			const s = _v2.copy( line2.end ).sub( line2.start );

			const w = _v3.copy( line2.start ).sub( line1.start );

			const a = r.dot( s ),
				b = r.dot( r ),
				c = s.dot( s ),
				d = s.dot( w ),
				e = r.dot( w );
			let t1, t2;
			const divisor = b * c - a * a;

			if ( Math.abs( divisor ) < EPS ) {

				const d1 = - d / c;
				const d2 = ( a - d ) / c;

				if ( Math.abs( d1 - 0.5 ) < Math.abs( d2 - 0.5 ) ) {

					t1 = 0;
					t2 = d1;

				} else {

					t1 = 1;
					t2 = d2;

				}

			} else {

				t1 = ( d * a + e * c ) / divisor;
				t2 = ( t1 * a - d ) / c;

			}

			t2 = Math.max( 0, Math.min( 1, t2 ) );
			t1 = Math.max( 0, Math.min( 1, t1 ) );
			const point1 = r.multiplyScalar( t1 ).add( line1.start );
			const point2 = s.multiplyScalar( t2 ).add( line2.start );
			return [ point1, point2 ];

		}

	}

	THREE.Capsule = Capsule;

} )();

/* --- three/examples/js/math/Octree.js --- */
( function () {

	const _v1 = new THREE.Vector3();

	const _v2 = new THREE.Vector3();

	const _plane = new THREE.Plane();

	const _line1 = new THREE.Line3();

	const _line2 = new THREE.Line3();

	const _sphere = new THREE.Sphere();

	const _capsule = new THREE.Capsule();

	class Octree {

		constructor( box ) {

			this.triangles = [];
			this.box = box;
			this.subTrees = [];

		}

		addTriangle( triangle ) {

			if ( ! this.bounds ) this.bounds = new THREE.Box3();
			this.bounds.min.x = Math.min( this.bounds.min.x, triangle.a.x, triangle.b.x, triangle.c.x );
			this.bounds.min.y = Math.min( this.bounds.min.y, triangle.a.y, triangle.b.y, triangle.c.y );
			this.bounds.min.z = Math.min( this.bounds.min.z, triangle.a.z, triangle.b.z, triangle.c.z );
			this.bounds.max.x = Math.max( this.bounds.max.x, triangle.a.x, triangle.b.x, triangle.c.x );
			this.bounds.max.y = Math.max( this.bounds.max.y, triangle.a.y, triangle.b.y, triangle.c.y );
			this.bounds.max.z = Math.max( this.bounds.max.z, triangle.a.z, triangle.b.z, triangle.c.z );
			this.triangles.push( triangle );
			return this;

		}

		calcBox() {

			this.box = this.bounds.clone(); // offset small ammount to account for regular grid

			this.box.min.x -= 0.01;
			this.box.min.y -= 0.01;
			this.box.min.z -= 0.01;
			return this;

		}

		split( level ) {

			if ( ! this.box ) return;
			const subTrees = [];

			const halfsize = _v2.copy( this.box.max ).sub( this.box.min ).multiplyScalar( 0.5 );

			for ( let x = 0; x < 2; x ++ ) {

				for ( let y = 0; y < 2; y ++ ) {

					for ( let z = 0; z < 2; z ++ ) {

						const box = new THREE.Box3();

						const v = _v1.set( x, y, z );

						box.min.copy( this.box.min ).add( v.multiply( halfsize ) );
						box.max.copy( box.min ).add( halfsize );
						subTrees.push( new Octree( box ) );

					}

				}

			}

			let triangle;

			while ( triangle = this.triangles.pop() ) {

				for ( let i = 0; i < subTrees.length; i ++ ) {

					if ( subTrees[ i ].box.intersectsTriangle( triangle ) ) {

						subTrees[ i ].triangles.push( triangle );

					}

				}

			}

			for ( let i = 0; i < subTrees.length; i ++ ) {

				const len = subTrees[ i ].triangles.length;

				if ( len > 8 && level < 16 ) {

					subTrees[ i ].split( level + 1 );

				}

				if ( len !== 0 ) {

					this.subTrees.push( subTrees[ i ] );

				}

			}

			return this;

		}

		build() {

			this.calcBox();
			this.split( 0 );
			return this;

		}

		getRayTriangles( ray, triangles ) {

			for ( let i = 0; i < this.subTrees.length; i ++ ) {

				const subTree = this.subTrees[ i ];
				if ( ! ray.intersectsBox( subTree.box ) ) continue;

				if ( subTree.triangles.length > 0 ) {

					for ( let j = 0; j < subTree.triangles.length; j ++ ) {

						if ( triangles.indexOf( subTree.triangles[ j ] ) === - 1 ) triangles.push( subTree.triangles[ j ] );

					}

				} else {

					subTree.getRayTriangles( ray, triangles );

				}

			}

			return triangles;

		}

		triangleCapsuleIntersect( capsule, triangle ) {

			triangle.getPlane( _plane );
			const d1 = _plane.distanceToPoint( capsule.start ) - capsule.radius;
			const d2 = _plane.distanceToPoint( capsule.end ) - capsule.radius;

			if ( d1 > 0 && d2 > 0 || d1 < - capsule.radius && d2 < - capsule.radius ) {

				return false;

			}

			const delta = Math.abs( d1 / ( Math.abs( d1 ) + Math.abs( d2 ) ) );

			const intersectPoint = _v1.copy( capsule.start ).lerp( capsule.end, delta );

			if ( triangle.containsPoint( intersectPoint ) ) {

				return {
					normal: _plane.normal.clone(),
					point: intersectPoint.clone(),
					depth: Math.abs( Math.min( d1, d2 ) )
				};

			}

			const r2 = capsule.radius * capsule.radius;

			const line1 = _line1.set( capsule.start, capsule.end );

			const lines = [[ triangle.a, triangle.b ], [ triangle.b, triangle.c ], [ triangle.c, triangle.a ]];

			for ( let i = 0; i < lines.length; i ++ ) {

				const line2 = _line2.set( lines[ i ][ 0 ], lines[ i ][ 1 ] );

				const [ point1, point2 ] = capsule.lineLineMinimumPoints( line1, line2 );

				if ( point1.distanceToSquared( point2 ) < r2 ) {

					return {
						normal: point1.clone().sub( point2 ).normalize(),
						point: point2.clone(),
						depth: capsule.radius - point1.distanceTo( point2 )
					};

				}

			}

			return false;

		}

		triangleSphereIntersect( sphere, triangle ) {

			triangle.getPlane( _plane );
			if ( ! sphere.intersectsPlane( _plane ) ) return false;
			const depth = Math.abs( _plane.distanceToSphere( sphere ) );
			const r2 = sphere.radius * sphere.radius - depth * depth;

			const plainPoint = _plane.projectPoint( sphere.center, _v1 );

			if ( triangle.containsPoint( sphere.center ) ) {

				return {
					normal: _plane.normal.clone(),
					point: plainPoint.clone(),
					depth: Math.abs( _plane.distanceToSphere( sphere ) )
				};

			}

			const lines = [[ triangle.a, triangle.b ], [ triangle.b, triangle.c ], [ triangle.c, triangle.a ]];

			for ( let i = 0; i < lines.length; i ++ ) {

				_line1.set( lines[ i ][ 0 ], lines[ i ][ 1 ] );

				_line1.closestPointToPoint( plainPoint, true, _v2 );

				const d = _v2.distanceToSquared( sphere.center );

				if ( d < r2 ) {

					return {
						normal: sphere.center.clone().sub( _v2 ).normalize(),
						point: _v2.clone(),
						depth: sphere.radius - Math.sqrt( d )
					};

				}

			}

			return false;

		}

		getSphereTriangles( sphere, triangles ) {

			for ( let i = 0; i < this.subTrees.length; i ++ ) {

				const subTree = this.subTrees[ i ];
				if ( ! sphere.intersectsBox( subTree.box ) ) continue;

				if ( subTree.triangles.length > 0 ) {

					for ( let j = 0; j < subTree.triangles.length; j ++ ) {

						if ( triangles.indexOf( subTree.triangles[ j ] ) === - 1 ) triangles.push( subTree.triangles[ j ] );

					}

				} else {

					subTree.getSphereTriangles( sphere, triangles );

				}

			}

		}

		getCapsuleTriangles( capsule, triangles ) {

			for ( let i = 0; i < this.subTrees.length; i ++ ) {

				const subTree = this.subTrees[ i ];
				if ( ! capsule.intersectsBox( subTree.box ) ) continue;

				if ( subTree.triangles.length > 0 ) {

					for ( let j = 0; j < subTree.triangles.length; j ++ ) {

						if ( triangles.indexOf( subTree.triangles[ j ] ) === - 1 ) triangles.push( subTree.triangles[ j ] );

					}

				} else {

					subTree.getCapsuleTriangles( capsule, triangles );

				}

			}

		}

		sphereIntersect( sphere ) {

			_sphere.copy( sphere );

			const triangles = [];
			let result,
				hit = false;
			this.getSphereTriangles( sphere, triangles );

			for ( let i = 0; i < triangles.length; i ++ ) {

				if ( result = this.triangleSphereIntersect( _sphere, triangles[ i ] ) ) {

					hit = true;

					_sphere.center.add( result.normal.multiplyScalar( result.depth ) );

				}

			}

			if ( hit ) {

				const collisionVector = _sphere.center.clone().sub( sphere.center );

				const depth = collisionVector.length();
				return {
					normal: collisionVector.normalize(),
					depth: depth
				};

			}

			return false;

		}

		capsuleIntersect( capsule ) {

			_capsule.copy( capsule );

			const triangles = [];
			let result,
				hit = false;
			this.getCapsuleTriangles( _capsule, triangles );

			for ( let i = 0; i < triangles.length; i ++ ) {

				if ( result = this.triangleCapsuleIntersect( _capsule, triangles[ i ] ) ) {

					hit = true;

					_capsule.translate( result.normal.multiplyScalar( result.depth ) );

				}

			}

			if ( hit ) {

				const collisionVector = _capsule.getCenter( new THREE.Vector3() ).sub( capsule.getCenter( _v1 ) );

				const depth = collisionVector.length();
				return {
					normal: collisionVector.normalize(),
					depth: depth
				};

			}

			return false;

		}

		rayIntersect( ray ) {

			if ( ray.direction.length() === 0 ) return;
			const triangles = [];
			let triangle,
				position,
				distance = 1e100;
			this.getRayTriangles( ray, triangles );

			for ( let i = 0; i < triangles.length; i ++ ) {

				const result = ray.intersectTriangle( triangles[ i ].a, triangles[ i ].b, triangles[ i ].c, true, _v1 );

				if ( result ) {

					const newdistance = result.sub( ray.origin ).length();

					if ( distance > newdistance ) {

						position = result.clone().add( ray.origin );
						distance = newdistance;
						triangle = triangles[ i ];

					}

				}

			}

			return distance < 1e100 ? {
				distance: distance,
				triangle: triangle,
				position: position
			} : false;

		}

		fromGraphNode( group ) {

			group.traverse( obj => {

				if ( obj.type === 'Mesh' ) {

					obj.updateMatrix();
					obj.updateWorldMatrix();
					let geometry,
						isTemp = false;

					if ( obj.geometry.index ) {

						isTemp = true;
						geometry = obj.geometry.clone().toNonIndexed();

					} else {

						geometry = obj.geometry;

					}

					const positions = geometry.attributes.position.array;
					const transform = obj.matrixWorld;

					for ( let i = 0; i < positions.length; i += 9 ) {

						const v1 = new THREE.Vector3( positions[ i ], positions[ i + 1 ], positions[ i + 2 ] );
						const v2 = new THREE.Vector3( positions[ i + 3 ], positions[ i + 4 ], positions[ i + 5 ] );
						const v3 = new THREE.Vector3( positions[ i + 6 ], positions[ i + 7 ], positions[ i + 8 ] );
						v1.applyMatrix4( transform );
						v2.applyMatrix4( transform );
						v3.applyMatrix4( transform );
						this.addTriangle( new THREE.Triangle( v1, v2, v3 ) );

					}

					if ( isTemp ) {

						geometry.dispose();

					}

				}

			} );
			this.build();
			return this;

		}

	}

	THREE.Octree = Octree;

} )();

/* --- three/examples/js/geometries/ConvexGeometry.js --- */
( function () {

	class ConvexGeometry extends THREE.BufferGeometry {

		constructor( points ) {

			super(); // buffers

			const vertices = [];
			const normals = [];

			if ( THREE.ConvexHull === undefined ) {

				console.error( 'THREE.ConvexBufferGeometry: ConvexBufferGeometry relies on THREE.ConvexHull' );

			}

			const convexHull = new THREE.ConvexHull().setFromPoints( points ); // generate vertices and normals

			const faces = convexHull.faces;

			for ( let i = 0; i < faces.length; i ++ ) {

				const face = faces[ i ];
				let edge = face.edge; // we move along a doubly-connected edge list to access all face points (see HalfEdge docs)

				do {

					const point = edge.head().point;
					vertices.push( point.x, point.y, point.z );
					normals.push( face.normal.x, face.normal.y, face.normal.z );
					edge = edge.next;

				} while ( edge !== face.edge );

			} // build geometry


			this.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
			this.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );

		}

	}

	THREE.ConvexGeometry = ConvexGeometry;

} )();

/* --- three/examples/js/geometries/RoundedBoxGeometry.js --- */
( function () {

	const _tempNormal = new THREE.Vector3();

	function getUv( faceDirVector, normal, uvAxis, projectionAxis, radius, sideLength ) {

		const totArcLength = 2 * Math.PI * radius / 4; // length of the planes between the arcs on each axis

		const centerLength = Math.max( sideLength - 2 * radius, 0 );
		const halfArc = Math.PI / 4; // Get the vector projected onto the Y plane

		_tempNormal.copy( normal );

		_tempNormal[ projectionAxis ] = 0;

		_tempNormal.normalize(); // total amount of UV space alloted to a single arc


		const arcUvRatio = 0.5 * totArcLength / ( totArcLength + centerLength ); // the distance along one arc the point is at

		const arcAngleRatio = 1.0 - _tempNormal.angleTo( faceDirVector ) / halfArc;

		if ( Math.sign( _tempNormal[ uvAxis ] ) === 1 ) {

			return arcAngleRatio * arcUvRatio;

		} else {

			// total amount of UV space alloted to the plane between the arcs
			const lenUv = centerLength / ( totArcLength + centerLength );
			return lenUv + arcUvRatio + arcUvRatio * ( 1.0 - arcAngleRatio );

		}

	}

	class RoundedBoxGeometry extends THREE.BoxGeometry {

		constructor( width = 1, height = 1, depth = 1, segments = 2, radius = 0.1 ) {

			// ensure segments is odd so we have a plane connecting the rounded corners
			segments = segments * 2 + 1; // ensure radius isn't bigger than shortest side

			radius = Math.min( width / 2, height / 2, depth / 2, radius );
			super( 1, 1, 1, segments, segments, segments ); // if we just have one segment we're the same as a regular box

			if ( segments === 1 ) return;
			const geometry2 = this.toNonIndexed();
			this.index = null;
			this.attributes.position = geometry2.attributes.position;
			this.attributes.normal = geometry2.attributes.normal;
			this.attributes.uv = geometry2.attributes.uv; //

			const position = new THREE.Vector3();
			const normal = new THREE.Vector3();
			const box = new THREE.Vector3( width, height, depth ).divideScalar( 2 ).subScalar( radius );
			const positions = this.attributes.position.array;
			const normals = this.attributes.normal.array;
			const uvs = this.attributes.uv.array;
			const faceTris = positions.length / 6;
			const faceDirVector = new THREE.Vector3();
			const halfSegmentSize = 0.5 / segments;

			for ( let i = 0, j = 0; i < positions.length; i += 3, j += 2 ) {

				position.fromArray( positions, i );
				normal.copy( position );
				normal.x -= Math.sign( normal.x ) * halfSegmentSize;
				normal.y -= Math.sign( normal.y ) * halfSegmentSize;
				normal.z -= Math.sign( normal.z ) * halfSegmentSize;
				normal.normalize();
				positions[ i + 0 ] = box.x * Math.sign( position.x ) + normal.x * radius;
				positions[ i + 1 ] = box.y * Math.sign( position.y ) + normal.y * radius;
				positions[ i + 2 ] = box.z * Math.sign( position.z ) + normal.z * radius;
				normals[ i + 0 ] = normal.x;
				normals[ i + 1 ] = normal.y;
				normals[ i + 2 ] = normal.z;
				const side = Math.floor( i / faceTris );

				switch ( side ) {

					case 0:
						// right
						// generate UVs along Z then Y
						faceDirVector.set( 1, 0, 0 );
						uvs[ j + 0 ] = getUv( faceDirVector, normal, 'z', 'y', radius, depth );
						uvs[ j + 1 ] = 1.0 - getUv( faceDirVector, normal, 'y', 'z', radius, height );
						break;

					case 1:
						// left
						// generate UVs along Z then Y
						faceDirVector.set( - 1, 0, 0 );
						uvs[ j + 0 ] = 1.0 - getUv( faceDirVector, normal, 'z', 'y', radius, depth );
						uvs[ j + 1 ] = 1.0 - getUv( faceDirVector, normal, 'y', 'z', radius, height );
						break;

					case 2:
						// top
						// generate UVs along X then Z
						faceDirVector.set( 0, 1, 0 );
						uvs[ j + 0 ] = 1.0 - getUv( faceDirVector, normal, 'x', 'z', radius, width );
						uvs[ j + 1 ] = getUv( faceDirVector, normal, 'z', 'x', radius, depth );
						break;

					case 3:
						// bottom
						// generate UVs along X then Z
						faceDirVector.set( 0, - 1, 0 );
						uvs[ j + 0 ] = 1.0 - getUv( faceDirVector, normal, 'x', 'z', radius, width );
						uvs[ j + 1 ] = 1.0 - getUv( faceDirVector, normal, 'z', 'x', radius, depth );
						break;

					case 4:
						// front
						// generate UVs along X then Y
						faceDirVector.set( 0, 0, 1 );
						uvs[ j + 0 ] = 1.0 - getUv( faceDirVector, normal, 'x', 'y', radius, width );
						uvs[ j + 1 ] = 1.0 - getUv( faceDirVector, normal, 'y', 'x', radius, height );
						break;

					case 5:
						// back
						// generate UVs along X then Y
						faceDirVector.set( 0, 0, - 1 );
						uvs[ j + 0 ] = getUv( faceDirVector, normal, 'x', 'y', radius, width );
						uvs[ j + 1 ] = 1.0 - getUv( faceDirVector, normal, 'y', 'x', radius, height );
						break;

				}

			}

		}

	}

	THREE.RoundedBoxGeometry = RoundedBoxGeometry;

} )();

/* --- three/examples/js/geometries/DecalGeometry.js --- */
( function () {

	/**
 * You can use this geometry to create a decal mesh, that serves different kinds of purposes.
 * e.g. adding unique details to models, performing dynamic visual environmental changes or covering seams.
 *
 * Constructor parameter:
 *
 * mesh — Any mesh object
 * position — Position of the decal projector
 * orientation — Orientation of the decal projector
 * size — Size of the decal projector
 *
 * reference: http://blog.wolfire.com/2009/06/how-to-project-decals/
 *
 */

	class DecalGeometry extends THREE.BufferGeometry {

		constructor( mesh, position, orientation, size ) {

			super(); // buffers

			const vertices = [];
			const normals = [];
			const uvs = []; // helpers

			const plane = new THREE.Vector3(); // this matrix represents the transformation of the decal projector

			const projectorMatrix = new THREE.Matrix4();
			projectorMatrix.makeRotationFromEuler( orientation );
			projectorMatrix.setPosition( position );
			const projectorMatrixInverse = new THREE.Matrix4();
			projectorMatrixInverse.copy( projectorMatrix ).invert(); // generate buffers

			generate(); // build geometry

			this.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
			this.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
			this.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );

			function generate() {

				let decalVertices = [];
				const vertex = new THREE.Vector3();
				const normal = new THREE.Vector3(); // handle different geometry types

				if ( mesh.geometry.isGeometry === true ) {

					console.error( 'THREE.DecalGeometry no longer supports THREE.Geometry. Use THREE.BufferGeometry instead.' );
					return;

				}

				const geometry = mesh.geometry;
				const positionAttribute = geometry.attributes.position;
				const normalAttribute = geometry.attributes.normal; // first, create an array of 'DecalVertex' objects
				// three consecutive 'DecalVertex' objects represent a single face
				//
				// this data structure will be later used to perform the clipping

				if ( geometry.index !== null ) {

					// indexed THREE.BufferGeometry
					const index = geometry.index;

					for ( let i = 0; i < index.count; i ++ ) {

						vertex.fromBufferAttribute( positionAttribute, index.getX( i ) );
						normal.fromBufferAttribute( normalAttribute, index.getX( i ) );
						pushDecalVertex( decalVertices, vertex, normal );

					}

				} else {

					// non-indexed THREE.BufferGeometry
					for ( let i = 0; i < positionAttribute.count; i ++ ) {

						vertex.fromBufferAttribute( positionAttribute, i );
						normal.fromBufferAttribute( normalAttribute, i );
						pushDecalVertex( decalVertices, vertex, normal );

					}

				} // second, clip the geometry so that it doesn't extend out from the projector


				decalVertices = clipGeometry( decalVertices, plane.set( 1, 0, 0 ) );
				decalVertices = clipGeometry( decalVertices, plane.set( - 1, 0, 0 ) );
				decalVertices = clipGeometry( decalVertices, plane.set( 0, 1, 0 ) );
				decalVertices = clipGeometry( decalVertices, plane.set( 0, - 1, 0 ) );
				decalVertices = clipGeometry( decalVertices, plane.set( 0, 0, 1 ) );
				decalVertices = clipGeometry( decalVertices, plane.set( 0, 0, - 1 ) ); // third, generate final vertices, normals and uvs

				for ( let i = 0; i < decalVertices.length; i ++ ) {

					const decalVertex = decalVertices[ i ]; // create texture coordinates (we are still in projector space)

					uvs.push( 0.5 + decalVertex.position.x / size.x, 0.5 + decalVertex.position.y / size.y ); // transform the vertex back to world space

					decalVertex.position.applyMatrix4( projectorMatrix ); // now create vertex and normal buffer data

					vertices.push( decalVertex.position.x, decalVertex.position.y, decalVertex.position.z );
					normals.push( decalVertex.normal.x, decalVertex.normal.y, decalVertex.normal.z );

				}

			}

			function pushDecalVertex( decalVertices, vertex, normal ) {

				// transform the vertex to world space, then to projector space
				vertex.applyMatrix4( mesh.matrixWorld );
				vertex.applyMatrix4( projectorMatrixInverse );
				normal.transformDirection( mesh.matrixWorld );
				decalVertices.push( new DecalVertex( vertex.clone(), normal.clone() ) );

			}

			function clipGeometry( inVertices, plane ) {

				const outVertices = [];
				const s = 0.5 * Math.abs( size.dot( plane ) ); // a single iteration clips one face,
				// which consists of three consecutive 'DecalVertex' objects

				for ( let i = 0; i < inVertices.length; i += 3 ) {

					let total = 0;
					let nV1;
					let nV2;
					let nV3;
					let nV4;
					const d1 = inVertices[ i + 0 ].position.dot( plane ) - s;
					const d2 = inVertices[ i + 1 ].position.dot( plane ) - s;
					const d3 = inVertices[ i + 2 ].position.dot( plane ) - s;
					const v1Out = d1 > 0;
					const v2Out = d2 > 0;
					const v3Out = d3 > 0; // calculate, how many vertices of the face lie outside of the clipping plane

					total = ( v1Out ? 1 : 0 ) + ( v2Out ? 1 : 0 ) + ( v3Out ? 1 : 0 );

					switch ( total ) {

						case 0:
						{

							// the entire face lies inside of the plane, no clipping needed
							outVertices.push( inVertices[ i ] );
							outVertices.push( inVertices[ i + 1 ] );
							outVertices.push( inVertices[ i + 2 ] );
							break;

						}

						case 1:
						{

							// one vertex lies outside of the plane, perform clipping
							if ( v1Out ) {

								nV1 = inVertices[ i + 1 ];
								nV2 = inVertices[ i + 2 ];
								nV3 = clip( inVertices[ i ], nV1, plane, s );
								nV4 = clip( inVertices[ i ], nV2, plane, s );

							}

							if ( v2Out ) {

								nV1 = inVertices[ i ];
								nV2 = inVertices[ i + 2 ];
								nV3 = clip( inVertices[ i + 1 ], nV1, plane, s );
								nV4 = clip( inVertices[ i + 1 ], nV2, plane, s );
								outVertices.push( nV3 );
								outVertices.push( nV2.clone() );
								outVertices.push( nV1.clone() );
								outVertices.push( nV2.clone() );
								outVertices.push( nV3.clone() );
								outVertices.push( nV4 );
								break;

							}

							if ( v3Out ) {

								nV1 = inVertices[ i ];
								nV2 = inVertices[ i + 1 ];
								nV3 = clip( inVertices[ i + 2 ], nV1, plane, s );
								nV4 = clip( inVertices[ i + 2 ], nV2, plane, s );

							}

							outVertices.push( nV1.clone() );
							outVertices.push( nV2.clone() );
							outVertices.push( nV3 );
							outVertices.push( nV4 );
							outVertices.push( nV3.clone() );
							outVertices.push( nV2.clone() );
							break;

						}

						case 2:
						{

							// two vertices lies outside of the plane, perform clipping
							if ( ! v1Out ) {

								nV1 = inVertices[ i ].clone();
								nV2 = clip( nV1, inVertices[ i + 1 ], plane, s );
								nV3 = clip( nV1, inVertices[ i + 2 ], plane, s );
								outVertices.push( nV1 );
								outVertices.push( nV2 );
								outVertices.push( nV3 );

							}

							if ( ! v2Out ) {

								nV1 = inVertices[ i + 1 ].clone();
								nV2 = clip( nV1, inVertices[ i + 2 ], plane, s );
								nV3 = clip( nV1, inVertices[ i ], plane, s );
								outVertices.push( nV1 );
								outVertices.push( nV2 );
								outVertices.push( nV3 );

							}

							if ( ! v3Out ) {

								nV1 = inVertices[ i + 2 ].clone();
								nV2 = clip( nV1, inVertices[ i ], plane, s );
								nV3 = clip( nV1, inVertices[ i + 1 ], plane, s );
								outVertices.push( nV1 );
								outVertices.push( nV2 );
								outVertices.push( nV3 );

							}

							break;

						}

						case 3:
						{

							// the entire face lies outside of the plane, so let's discard the corresponding vertices
							break;

						}

					}

				}

				return outVertices;

			}

			function clip( v0, v1, p, s ) {

				const d0 = v0.position.dot( p ) - s;
				const d1 = v1.position.dot( p ) - s;
				const s0 = d0 / ( d0 - d1 );
				const v = new DecalVertex( new THREE.Vector3( v0.position.x + s0 * ( v1.position.x - v0.position.x ), v0.position.y + s0 * ( v1.position.y - v0.position.y ), v0.position.z + s0 * ( v1.position.z - v0.position.z ) ), new THREE.Vector3( v0.normal.x + s0 * ( v1.normal.x - v0.normal.x ), v0.normal.y + s0 * ( v1.normal.y - v0.normal.y ), v0.normal.z + s0 * ( v1.normal.z - v0.normal.z ) ) ); // need to clip more values (texture coordinates)? do it this way:
				// intersectpoint.value = a.value + s * ( b.value - a.value );

				return v;

			}

		}

	} // helper


	class DecalVertex {

		constructor( position, normal ) {

			this.position = position;
			this.normal = normal;

		}

		clone() {

			return new this.constructor( this.position.clone(), this.normal.clone() );

		}

	}

	THREE.DecalGeometry = DecalGeometry;
	THREE.DecalVertex = DecalVertex;

} )();

/* --- three/examples/js/controls/TransformControls.js --- */
( function () {

	const _raycaster = new THREE.Raycaster();

	const _tempVector = new THREE.Vector3();

	const _tempVector2 = new THREE.Vector3();

	const _tempQuaternion = new THREE.Quaternion();

	const _unit = {
		X: new THREE.Vector3( 1, 0, 0 ),
		Y: new THREE.Vector3( 0, 1, 0 ),
		Z: new THREE.Vector3( 0, 0, 1 )
	};
	const _changeEvent = {
		type: 'change'
	};
	const _mouseDownEvent = {
		type: 'mouseDown'
	};
	const _mouseUpEvent = {
		type: 'mouseUp',
		mode: null
	};
	const _objectChangeEvent = {
		type: 'objectChange'
	};

	class TransformControls extends THREE.Object3D {

		constructor( camera, domElement ) {

			super();

			if ( domElement === undefined ) {

				console.warn( 'THREE.TransformControls: The second parameter "domElement" is now mandatory.' );
				domElement = document;

			}

			this.visible = false;
			this.domElement = domElement;

			const _gizmo = new TransformControlsGizmo();

			this._gizmo = _gizmo;
			this.add( _gizmo );

			const _plane = new TransformControlsPlane();

			this._plane = _plane;
			this.add( _plane );
			const scope = this; // Defined getter, setter and store for a property

			function defineProperty( propName, defaultValue ) {

				let propValue = defaultValue;
				Object.defineProperty( scope, propName, {
					get: function () {

						return propValue !== undefined ? propValue : defaultValue;

					},
					set: function ( value ) {

						if ( propValue !== value ) {

							propValue = value;
							_plane[ propName ] = value;
							_gizmo[ propName ] = value;
							scope.dispatchEvent( {
								type: propName + '-changed',
								value: value
							} );
							scope.dispatchEvent( _changeEvent );

						}

					}
				} );
				scope[ propName ] = defaultValue;
				_plane[ propName ] = defaultValue;
				_gizmo[ propName ] = defaultValue;

			} // Define properties with getters/setter
			// Setting the defined property will automatically trigger change event
			// Defined properties are passed down to gizmo and plane


			defineProperty( 'camera', camera );
			defineProperty( 'object', undefined );
			defineProperty( 'enabled', true );
			defineProperty( 'axis', null );
			defineProperty( 'mode', 'translate' );
			defineProperty( 'translationSnap', null );
			defineProperty( 'rotationSnap', null );
			defineProperty( 'scaleSnap', null );
			defineProperty( 'space', 'world' );
			defineProperty( 'size', 1 );
			defineProperty( 'dragging', false );
			defineProperty( 'showX', true );
			defineProperty( 'showY', true );
			defineProperty( 'showZ', true ); // Reusable utility variables

			const worldPosition = new THREE.Vector3();
			const worldPositionStart = new THREE.Vector3();
			const worldQuaternion = new THREE.Quaternion();
			const worldQuaternionStart = new THREE.Quaternion();
			const cameraPosition = new THREE.Vector3();
			const cameraQuaternion = new THREE.Quaternion();
			const pointStart = new THREE.Vector3();
			const pointEnd = new THREE.Vector3();
			const rotationAxis = new THREE.Vector3();
			const rotationAngle = 0;
			const eye = new THREE.Vector3(); // TODO: remove properties unused in plane and gizmo

			defineProperty( 'worldPosition', worldPosition );
			defineProperty( 'worldPositionStart', worldPositionStart );
			defineProperty( 'worldQuaternion', worldQuaternion );
			defineProperty( 'worldQuaternionStart', worldQuaternionStart );
			defineProperty( 'cameraPosition', cameraPosition );
			defineProperty( 'cameraQuaternion', cameraQuaternion );
			defineProperty( 'pointStart', pointStart );
			defineProperty( 'pointEnd', pointEnd );
			defineProperty( 'rotationAxis', rotationAxis );
			defineProperty( 'rotationAngle', rotationAngle );
			defineProperty( 'eye', eye );
			this._offset = new THREE.Vector3();
			this._startNorm = new THREE.Vector3();
			this._endNorm = new THREE.Vector3();
			this._cameraScale = new THREE.Vector3();
			this._parentPosition = new THREE.Vector3();
			this._parentQuaternion = new THREE.Quaternion();
			this._parentQuaternionInv = new THREE.Quaternion();
			this._parentScale = new THREE.Vector3();
			this._worldScaleStart = new THREE.Vector3();
			this._worldQuaternionInv = new THREE.Quaternion();
			this._worldScale = new THREE.Vector3();
			this._positionStart = new THREE.Vector3();
			this._quaternionStart = new THREE.Quaternion();
			this._scaleStart = new THREE.Vector3();
			this._getPointer = getPointer.bind( this );
			this._onPointerDown = onPointerDown.bind( this );
			this._onPointerHover = onPointerHover.bind( this );
			this._onPointerMove = onPointerMove.bind( this );
			this._onPointerUp = onPointerUp.bind( this );
			this.domElement.addEventListener( 'pointerdown', this._onPointerDown );
			this.domElement.addEventListener( 'pointermove', this._onPointerHover );
			this.domElement.ownerDocument.addEventListener( 'pointerup', this._onPointerUp );

		} // updateMatrixWorld  updates key transformation variables


		updateMatrixWorld() {

			if ( this.object !== undefined ) {

				this.object.updateMatrixWorld();

				if ( this.object.parent === null ) {

					console.error( 'TransformControls: The attached 3D object must be a part of the scene graph.' );

				} else {

					this.object.parent.matrixWorld.decompose( this._parentPosition, this._parentQuaternion, this._parentScale );

				}

				this.object.matrixWorld.decompose( this.worldPosition, this.worldQuaternion, this._worldScale );

				this._parentQuaternionInv.copy( this._parentQuaternion ).invert();

				this._worldQuaternionInv.copy( this.worldQuaternion ).invert();

			}

			this.camera.updateMatrixWorld();
			this.camera.matrixWorld.decompose( this.cameraPosition, this.cameraQuaternion, this._cameraScale );
			this.eye.copy( this.cameraPosition ).sub( this.worldPosition ).normalize();
			super.updateMatrixWorld( this );

		}

		pointerHover( pointer ) {

			if ( this.object === undefined || this.dragging === true ) return;

			_raycaster.setFromCamera( pointer, this.camera );

			const intersect = intersectObjectWithRay( this._gizmo.picker[ this.mode ], _raycaster );

			if ( intersect ) {

				this.axis = intersect.object.name;

			} else {

				this.axis = null;

			}

		}

		pointerDown( pointer ) {

			if ( this.object === undefined || this.dragging === true || pointer.button !== 0 ) return;

			if ( this.axis !== null ) {

				_raycaster.setFromCamera( pointer, this.camera );

				const planeIntersect = intersectObjectWithRay( this._plane, _raycaster, true );

				if ( planeIntersect ) {

					let space = this.space;

					if ( this.mode === 'scale' ) {

						space = 'local';

					} else if ( this.axis === 'E' || this.axis === 'XYZE' || this.axis === 'XYZ' ) {

						space = 'world';

					}

					if ( space === 'local' && this.mode === 'rotate' ) {

						const snap = this.rotationSnap;
						if ( this.axis === 'X' && snap ) this.object.rotation.x = Math.round( this.object.rotation.x / snap ) * snap;
						if ( this.axis === 'Y' && snap ) this.object.rotation.y = Math.round( this.object.rotation.y / snap ) * snap;
						if ( this.axis === 'Z' && snap ) this.object.rotation.z = Math.round( this.object.rotation.z / snap ) * snap;

					}

					this.object.updateMatrixWorld();
					this.object.parent.updateMatrixWorld();

					this._positionStart.copy( this.object.position );

					this._quaternionStart.copy( this.object.quaternion );

					this._scaleStart.copy( this.object.scale );

					this.object.matrixWorld.decompose( this.worldPositionStart, this.worldQuaternionStart, this._worldScaleStart );
					this.pointStart.copy( planeIntersect.point ).sub( this.worldPositionStart );

				}

				this.dragging = true;
				_mouseDownEvent.mode = this.mode;
				this.dispatchEvent( _mouseDownEvent );

			}

		}

		pointerMove( pointer ) {

			const axis = this.axis;
			const mode = this.mode;
			const object = this.object;
			let space = this.space;

			if ( mode === 'scale' ) {

				space = 'local';

			} else if ( axis === 'E' || axis === 'XYZE' || axis === 'XYZ' ) {

				space = 'world';

			}

			if ( object === undefined || axis === null || this.dragging === false || pointer.button !== - 1 ) return;

			_raycaster.setFromCamera( pointer, this.camera );

			const planeIntersect = intersectObjectWithRay( this._plane, _raycaster, true );
			if ( ! planeIntersect ) return;
			this.pointEnd.copy( planeIntersect.point ).sub( this.worldPositionStart );

			if ( mode === 'translate' ) {

				// Apply translate
				this._offset.copy( this.pointEnd ).sub( this.pointStart );

				if ( space === 'local' && axis !== 'XYZ' ) {

					this._offset.applyQuaternion( this._worldQuaternionInv );

				}

				if ( axis.indexOf( 'X' ) === - 1 ) this._offset.x = 0;
				if ( axis.indexOf( 'Y' ) === - 1 ) this._offset.y = 0;
				if ( axis.indexOf( 'Z' ) === - 1 ) this._offset.z = 0;

				if ( space === 'local' && axis !== 'XYZ' ) {

					this._offset.applyQuaternion( this._quaternionStart ).divide( this._parentScale );

				} else {

					this._offset.applyQuaternion( this._parentQuaternionInv ).divide( this._parentScale );

				}

				object.position.copy( this._offset ).add( this._positionStart ); // Apply translation snap

				if ( this.translationSnap ) {

					if ( space === 'local' ) {

						object.position.applyQuaternion( _tempQuaternion.copy( this._quaternionStart ).invert() );

						if ( axis.search( 'X' ) !== - 1 ) {

							object.position.x = Math.round( object.position.x / this.translationSnap ) * this.translationSnap;

						}

						if ( axis.search( 'Y' ) !== - 1 ) {

							object.position.y = Math.round( object.position.y / this.translationSnap ) * this.translationSnap;

						}

						if ( axis.search( 'Z' ) !== - 1 ) {

							object.position.z = Math.round( object.position.z / this.translationSnap ) * this.translationSnap;

						}

						object.position.applyQuaternion( this._quaternionStart );

					}

					if ( space === 'world' ) {

						if ( object.parent ) {

							object.position.add( _tempVector.setFromMatrixPosition( object.parent.matrixWorld ) );

						}

						if ( axis.search( 'X' ) !== - 1 ) {

							object.position.x = Math.round( object.position.x / this.translationSnap ) * this.translationSnap;

						}

						if ( axis.search( 'Y' ) !== - 1 ) {

							object.position.y = Math.round( object.position.y / this.translationSnap ) * this.translationSnap;

						}

						if ( axis.search( 'Z' ) !== - 1 ) {

							object.position.z = Math.round( object.position.z / this.translationSnap ) * this.translationSnap;

						}

						if ( object.parent ) {

							object.position.sub( _tempVector.setFromMatrixPosition( object.parent.matrixWorld ) );

						}

					}

				}

			} else if ( mode === 'scale' ) {

				if ( axis.search( 'XYZ' ) !== - 1 ) {

					let d = this.pointEnd.length() / this.pointStart.length();
					if ( this.pointEnd.dot( this.pointStart ) < 0 ) d *= - 1;

					_tempVector2.set( d, d, d );

				} else {

					_tempVector.copy( this.pointStart );

					_tempVector2.copy( this.pointEnd );

					_tempVector.applyQuaternion( this._worldQuaternionInv );

					_tempVector2.applyQuaternion( this._worldQuaternionInv );

					_tempVector2.divide( _tempVector );

					if ( axis.search( 'X' ) === - 1 ) {

						_tempVector2.x = 1;

					}

					if ( axis.search( 'Y' ) === - 1 ) {

						_tempVector2.y = 1;

					}

					if ( axis.search( 'Z' ) === - 1 ) {

						_tempVector2.z = 1;

					}

				} // Apply scale


				object.scale.copy( this._scaleStart ).multiply( _tempVector2 );

				if ( this.scaleSnap ) {

					if ( axis.search( 'X' ) !== - 1 ) {

						object.scale.x = Math.round( object.scale.x / this.scaleSnap ) * this.scaleSnap || this.scaleSnap;

					}

					if ( axis.search( 'Y' ) !== - 1 ) {

						object.scale.y = Math.round( object.scale.y / this.scaleSnap ) * this.scaleSnap || this.scaleSnap;

					}

					if ( axis.search( 'Z' ) !== - 1 ) {

						object.scale.z = Math.round( object.scale.z / this.scaleSnap ) * this.scaleSnap || this.scaleSnap;

					}

				}

			} else if ( mode === 'rotate' ) {

				this._offset.copy( this.pointEnd ).sub( this.pointStart );

				const ROTATION_SPEED = 20 / this.worldPosition.distanceTo( _tempVector.setFromMatrixPosition( this.camera.matrixWorld ) );

				if ( axis === 'E' ) {

					this.rotationAxis.copy( this.eye );
					this.rotationAngle = this.pointEnd.angleTo( this.pointStart );

					this._startNorm.copy( this.pointStart ).normalize();

					this._endNorm.copy( this.pointEnd ).normalize();

					this.rotationAngle *= this._endNorm.cross( this._startNorm ).dot( this.eye ) < 0 ? 1 : - 1;

				} else if ( axis === 'XYZE' ) {

					this.rotationAxis.copy( this._offset ).cross( this.eye ).normalize();
					this.rotationAngle = this._offset.dot( _tempVector.copy( this.rotationAxis ).cross( this.eye ) ) * ROTATION_SPEED;

				} else if ( axis === 'X' || axis === 'Y' || axis === 'Z' ) {

					this.rotationAxis.copy( _unit[ axis ] );

					_tempVector.copy( _unit[ axis ] );

					if ( space === 'local' ) {

						_tempVector.applyQuaternion( this.worldQuaternion );

					}

					this.rotationAngle = this._offset.dot( _tempVector.cross( this.eye ).normalize() ) * ROTATION_SPEED;

				} // Apply rotation snap


				if ( this.rotationSnap ) this.rotationAngle = Math.round( this.rotationAngle / this.rotationSnap ) * this.rotationSnap; // Apply rotate

				if ( space === 'local' && axis !== 'E' && axis !== 'XYZE' ) {

					object.quaternion.copy( this._quaternionStart );
					object.quaternion.multiply( _tempQuaternion.setFromAxisAngle( this.rotationAxis, this.rotationAngle ) ).normalize();

				} else {

					this.rotationAxis.applyQuaternion( this._parentQuaternionInv );
					object.quaternion.copy( _tempQuaternion.setFromAxisAngle( this.rotationAxis, this.rotationAngle ) );
					object.quaternion.multiply( this._quaternionStart ).normalize();

				}

			}

			this.dispatchEvent( _changeEvent );
			this.dispatchEvent( _objectChangeEvent );

		}

		pointerUp( pointer ) {

			if ( pointer.button !== 0 ) return;

			if ( this.dragging && this.axis !== null ) {

				_mouseUpEvent.mode = this.mode;
				this.dispatchEvent( _mouseUpEvent );

			}

			this.dragging = false;
			this.axis = null;

		}

		dispose() {

			this.domElement.removeEventListener( 'pointerdown', this._onPointerDown );
			this.domElement.removeEventListener( 'pointermove', this._onPointerHover );
			this.domElement.ownerDocument.removeEventListener( 'pointermove', this._onPointerMove );
			this.domElement.ownerDocument.removeEventListener( 'pointerup', this._onPointerUp );
			this.traverse( function ( child ) {

				if ( child.geometry ) child.geometry.dispose();
				if ( child.material ) child.material.dispose();

			} );

		} // Set current object


		attach( object ) {

			this.object = object;
			this.visible = true;
			return this;

		} // Detatch from object


		detach() {

			this.object = undefined;
			this.visible = false;
			this.axis = null;
			return this;

		} // TODO: deprecate


		getMode() {

			return this.mode;

		}

		setMode( mode ) {

			this.mode = mode;

		}

		setTranslationSnap( translationSnap ) {

			this.translationSnap = translationSnap;

		}

		setRotationSnap( rotationSnap ) {

			this.rotationSnap = rotationSnap;

		}

		setScaleSnap( scaleSnap ) {

			this.scaleSnap = scaleSnap;

		}

		setSize( size ) {

			this.size = size;

		}

		setSpace( space ) {

			this.space = space;

		}

		update() {

			console.warn( 'THREE.TransformControls: update function has no more functionality and therefore has been deprecated.' );

		}

	}

	TransformControls.prototype.isTransformControls = true; // mouse / touch event handlers

	function getPointer( event ) {

		if ( this.domElement.ownerDocument.pointerLockElement ) {

			return {
				x: 0,
				y: 0,
				button: event.button
			};

		} else {

			const pointer = event.changedTouches ? event.changedTouches[ 0 ] : event;
			const rect = this.domElement.getBoundingClientRect();
			return {
				x: ( pointer.clientX - rect.left ) / rect.width * 2 - 1,
				y: - ( pointer.clientY - rect.top ) / rect.height * 2 + 1,
				button: event.button
			};

		}

	}

	function onPointerHover( event ) {

		if ( ! this.enabled ) return;

		switch ( event.pointerType ) {

			case 'mouse':
			case 'pen':
				this.pointerHover( this._getPointer( event ) );
				break;

		}

	}

	function onPointerDown( event ) {

		if ( ! this.enabled ) return;
		this.domElement.style.touchAction = 'none'; // disable touch scroll

		this.domElement.ownerDocument.addEventListener( 'pointermove', this._onPointerMove );
		this.pointerHover( this._getPointer( event ) );
		this.pointerDown( this._getPointer( event ) );

	}

	function onPointerMove( event ) {

		if ( ! this.enabled ) return;
		this.pointerMove( this._getPointer( event ) );

	}

	function onPointerUp( event ) {

		if ( ! this.enabled ) return;
		this.domElement.style.touchAction = '';
		this.domElement.ownerDocument.removeEventListener( 'pointermove', this._onPointerMove );
		this.pointerUp( this._getPointer( event ) );

	}

	function intersectObjectWithRay( object, raycaster, includeInvisible ) {

		const allIntersections = raycaster.intersectObject( object, true );

		for ( let i = 0; i < allIntersections.length; i ++ ) {

			if ( allIntersections[ i ].object.visible || includeInvisible ) {

				return allIntersections[ i ];

			}

		}

		return false;

	} //
	// Reusable utility variables


	const _tempEuler = new THREE.Euler();

	const _alignVector = new THREE.Vector3( 0, 1, 0 );

	const _zeroVector = new THREE.Vector3( 0, 0, 0 );

	const _lookAtMatrix = new THREE.Matrix4();

	const _tempQuaternion2 = new THREE.Quaternion();

	const _identityQuaternion = new THREE.Quaternion();

	const _dirVector = new THREE.Vector3();

	const _tempMatrix = new THREE.Matrix4();

	const _unitX = new THREE.Vector3( 1, 0, 0 );

	const _unitY = new THREE.Vector3( 0, 1, 0 );

	const _unitZ = new THREE.Vector3( 0, 0, 1 );

	const _v1 = new THREE.Vector3();

	const _v2 = new THREE.Vector3();

	const _v3 = new THREE.Vector3();

	class TransformControlsGizmo extends THREE.Object3D {

		constructor() {

			super();
			this.type = 'TransformControlsGizmo'; // shared materials

			const gizmoMaterial = new THREE.MeshBasicMaterial( {
				depthTest: false,
				depthWrite: false,
				transparent: true,
				side: THREE.DoubleSide,
				fog: false,
				toneMapped: false
			} );
			const gizmoLineMaterial = new THREE.LineBasicMaterial( {
				depthTest: false,
				depthWrite: false,
				transparent: true,
				linewidth: 1,
				fog: false,
				toneMapped: false
			} ); // Make unique material for each axis/color

			const matInvisible = gizmoMaterial.clone();
			matInvisible.opacity = 0.15;
			const matHelper = gizmoMaterial.clone();
			matHelper.opacity = 0.33;
			const matRed = gizmoMaterial.clone();
			matRed.color.set( 0xff0000 );
			const matGreen = gizmoMaterial.clone();
			matGreen.color.set( 0x00ff00 );
			const matBlue = gizmoMaterial.clone();
			matBlue.color.set( 0x0000ff );
			const matWhiteTransparent = gizmoMaterial.clone();
			matWhiteTransparent.opacity = 0.25;
			const matYellowTransparent = matWhiteTransparent.clone();
			matYellowTransparent.color.set( 0xffff00 );
			const matCyanTransparent = matWhiteTransparent.clone();
			matCyanTransparent.color.set( 0x00ffff );
			const matMagentaTransparent = matWhiteTransparent.clone();
			matMagentaTransparent.color.set( 0xff00ff );
			const matYellow = gizmoMaterial.clone();
			matYellow.color.set( 0xffff00 );
			const matLineRed = gizmoLineMaterial.clone();
			matLineRed.color.set( 0xff0000 );
			const matLineGreen = gizmoLineMaterial.clone();
			matLineGreen.color.set( 0x00ff00 );
			const matLineBlue = gizmoLineMaterial.clone();
			matLineBlue.color.set( 0x0000ff );
			const matLineCyan = gizmoLineMaterial.clone();
			matLineCyan.color.set( 0x00ffff );
			const matLineMagenta = gizmoLineMaterial.clone();
			matLineMagenta.color.set( 0xff00ff );
			const matLineYellow = gizmoLineMaterial.clone();
			matLineYellow.color.set( 0xffff00 );
			const matLineGray = gizmoLineMaterial.clone();
			matLineGray.color.set( 0x787878 );
			const matLineYellowTransparent = matLineYellow.clone();
			matLineYellowTransparent.opacity = 0.25; // reusable geometry

			const arrowGeometry = new THREE.CylinderGeometry( 0, 0.05, 0.2, 12, 1, false );
			const scaleHandleGeometry = new THREE.BoxGeometry( 0.125, 0.125, 0.125 );
			const lineGeometry = new THREE.BufferGeometry();
			lineGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0 ], 3 ) );

			function CircleGeometry( radius, arc ) {

				const geometry = new THREE.BufferGeometry();
				const vertices = [];

				for ( let i = 0; i <= 64 * arc; ++ i ) {

					vertices.push( 0, Math.cos( i / 32 * Math.PI ) * radius, Math.sin( i / 32 * Math.PI ) * radius );

				}

				geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
				return geometry;

			} // Special geometry for transform helper. If scaled with position vector it spans from [0,0,0] to position


			function TranslateHelperGeometry() {

				const geometry = new THREE.BufferGeometry();
				geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( [ 0, 0, 0, 1, 1, 1 ], 3 ) );
				return geometry;

			} // Gizmo definitions - custom hierarchy definitions for setupGizmo() function


			const gizmoTranslate = {
				X: [[ new THREE.Mesh( arrowGeometry, matRed ), [ 1, 0, 0 ], [ 0, 0, - Math.PI / 2 ], null, 'fwd' ], [ new THREE.Mesh( arrowGeometry, matRed ), [ 1, 0, 0 ], [ 0, 0, Math.PI / 2 ], null, 'bwd' ], [ new THREE.Line( lineGeometry, matLineRed ) ]],
				Y: [[ new THREE.Mesh( arrowGeometry, matGreen ), [ 0, 1, 0 ], null, null, 'fwd' ], [ new THREE.Mesh( arrowGeometry, matGreen ), [ 0, 1, 0 ], [ Math.PI, 0, 0 ], null, 'bwd' ], [ new THREE.Line( lineGeometry, matLineGreen ), null, [ 0, 0, Math.PI / 2 ]]],
				Z: [[ new THREE.Mesh( arrowGeometry, matBlue ), [ 0, 0, 1 ], [ Math.PI / 2, 0, 0 ], null, 'fwd' ], [ new THREE.Mesh( arrowGeometry, matBlue ), [ 0, 0, 1 ], [ - Math.PI / 2, 0, 0 ], null, 'bwd' ], [ new THREE.Line( lineGeometry, matLineBlue ), null, [ 0, - Math.PI / 2, 0 ]]],
				XYZ: [[ new THREE.Mesh( new THREE.OctahedronGeometry( 0.1, 0 ), matWhiteTransparent.clone() ), [ 0, 0, 0 ], [ 0, 0, 0 ]]],
				XY: [[ new THREE.Mesh( new THREE.PlaneGeometry( 0.295, 0.295 ), matYellowTransparent.clone() ), [ 0.15, 0.15, 0 ]], [ new THREE.Line( lineGeometry, matLineYellow ), [ 0.18, 0.3, 0 ], null, [ 0.125, 1, 1 ]], [ new THREE.Line( lineGeometry, matLineYellow ), [ 0.3, 0.18, 0 ], [ 0, 0, Math.PI / 2 ], [ 0.125, 1, 1 ]]],
				YZ: [[ new THREE.Mesh( new THREE.PlaneGeometry( 0.295, 0.295 ), matCyanTransparent.clone() ), [ 0, 0.15, 0.15 ], [ 0, Math.PI / 2, 0 ]], [ new THREE.Line( lineGeometry, matLineCyan ), [ 0, 0.18, 0.3 ], [ 0, 0, Math.PI / 2 ], [ 0.125, 1, 1 ]], [ new THREE.Line( lineGeometry, matLineCyan ), [ 0, 0.3, 0.18 ], [ 0, - Math.PI / 2, 0 ], [ 0.125, 1, 1 ]]],
				XZ: [[ new THREE.Mesh( new THREE.PlaneGeometry( 0.295, 0.295 ), matMagentaTransparent.clone() ), [ 0.15, 0, 0.15 ], [ - Math.PI / 2, 0, 0 ]], [ new THREE.Line( lineGeometry, matLineMagenta ), [ 0.18, 0, 0.3 ], null, [ 0.125, 1, 1 ]], [ new THREE.Line( lineGeometry, matLineMagenta ), [ 0.3, 0, 0.18 ], [ 0, - Math.PI / 2, 0 ], [ 0.125, 1, 1 ]]]
			};
			const pickerTranslate = {
				X: [[ new THREE.Mesh( new THREE.CylinderGeometry( 0.2, 0, 1, 4, 1, false ), matInvisible ), [ 0.6, 0, 0 ], [ 0, 0, - Math.PI / 2 ]]],
				Y: [[ new THREE.Mesh( new THREE.CylinderGeometry( 0.2, 0, 1, 4, 1, false ), matInvisible ), [ 0, 0.6, 0 ]]],
				Z: [[ new THREE.Mesh( new THREE.CylinderGeometry( 0.2, 0, 1, 4, 1, false ), matInvisible ), [ 0, 0, 0.6 ], [ Math.PI / 2, 0, 0 ]]],
				XYZ: [[ new THREE.Mesh( new THREE.OctahedronGeometry( 0.2, 0 ), matInvisible ) ]],
				XY: [[ new THREE.Mesh( new THREE.PlaneGeometry( 0.4, 0.4 ), matInvisible ), [ 0.2, 0.2, 0 ]]],
				YZ: [[ new THREE.Mesh( new THREE.PlaneGeometry( 0.4, 0.4 ), matInvisible ), [ 0, 0.2, 0.2 ], [ 0, Math.PI / 2, 0 ]]],
				XZ: [[ new THREE.Mesh( new THREE.PlaneGeometry( 0.4, 0.4 ), matInvisible ), [ 0.2, 0, 0.2 ], [ - Math.PI / 2, 0, 0 ]]]
			};
			const helperTranslate = {
				START: [[ new THREE.Mesh( new THREE.OctahedronGeometry( 0.01, 2 ), matHelper ), null, null, null, 'helper' ]],
				END: [[ new THREE.Mesh( new THREE.OctahedronGeometry( 0.01, 2 ), matHelper ), null, null, null, 'helper' ]],
				DELTA: [[ new THREE.Line( TranslateHelperGeometry(), matHelper ), null, null, null, 'helper' ]],
				X: [[ new THREE.Line( lineGeometry, matHelper.clone() ), [ - 1e3, 0, 0 ], null, [ 1e6, 1, 1 ], 'helper' ]],
				Y: [[ new THREE.Line( lineGeometry, matHelper.clone() ), [ 0, - 1e3, 0 ], [ 0, 0, Math.PI / 2 ], [ 1e6, 1, 1 ], 'helper' ]],
				Z: [[ new THREE.Line( lineGeometry, matHelper.clone() ), [ 0, 0, - 1e3 ], [ 0, - Math.PI / 2, 0 ], [ 1e6, 1, 1 ], 'helper' ]]
			};
			const gizmoRotate = {
				X: [[ new THREE.Line( CircleGeometry( 1, 0.5 ), matLineRed ) ], [ new THREE.Mesh( new THREE.OctahedronGeometry( 0.04, 0 ), matRed ), [ 0, 0, 0.99 ], null, [ 1, 3, 1 ]]],
				Y: [[ new THREE.Line( CircleGeometry( 1, 0.5 ), matLineGreen ), null, [ 0, 0, - Math.PI / 2 ]], [ new THREE.Mesh( new THREE.OctahedronGeometry( 0.04, 0 ), matGreen ), [ 0, 0, 0.99 ], null, [ 3, 1, 1 ]]],
				Z: [[ new THREE.Line( CircleGeometry( 1, 0.5 ), matLineBlue ), null, [ 0, Math.PI / 2, 0 ]], [ new THREE.Mesh( new THREE.OctahedronGeometry( 0.04, 0 ), matBlue ), [ 0.99, 0, 0 ], null, [ 1, 3, 1 ]]],
				E: [[ new THREE.Line( CircleGeometry( 1.25, 1 ), matLineYellowTransparent ), null, [ 0, Math.PI / 2, 0 ]], [ new THREE.Mesh( new THREE.CylinderGeometry( 0.03, 0, 0.15, 4, 1, false ), matLineYellowTransparent ), [ 1.17, 0, 0 ], [ 0, 0, - Math.PI / 2 ], [ 1, 1, 0.001 ]], [ new THREE.Mesh( new THREE.CylinderGeometry( 0.03, 0, 0.15, 4, 1, false ), matLineYellowTransparent ), [ - 1.17, 0, 0 ], [ 0, 0, Math.PI / 2 ], [ 1, 1, 0.001 ]], [ new THREE.Mesh( new THREE.CylinderGeometry( 0.03, 0, 0.15, 4, 1, false ), matLineYellowTransparent ), [ 0, - 1.17, 0 ], [ Math.PI, 0, 0 ], [ 1, 1, 0.001 ]], [ new THREE.Mesh( new THREE.CylinderGeometry( 0.03, 0, 0.15, 4, 1, false ), matLineYellowTransparent ), [ 0, 1.17, 0 ], [ 0, 0, 0 ], [ 1, 1, 0.001 ]]],
				XYZE: [[ new THREE.Line( CircleGeometry( 1, 1 ), matLineGray ), null, [ 0, Math.PI / 2, 0 ]]]
			};
			const helperRotate = {
				AXIS: [[ new THREE.Line( lineGeometry, matHelper.clone() ), [ - 1e3, 0, 0 ], null, [ 1e6, 1, 1 ], 'helper' ]]
			};
			const pickerRotate = {
				X: [[ new THREE.Mesh( new THREE.TorusGeometry( 1, 0.1, 4, 24 ), matInvisible ), [ 0, 0, 0 ], [ 0, - Math.PI / 2, - Math.PI / 2 ]]],
				Y: [[ new THREE.Mesh( new THREE.TorusGeometry( 1, 0.1, 4, 24 ), matInvisible ), [ 0, 0, 0 ], [ Math.PI / 2, 0, 0 ]]],
				Z: [[ new THREE.Mesh( new THREE.TorusGeometry( 1, 0.1, 4, 24 ), matInvisible ), [ 0, 0, 0 ], [ 0, 0, - Math.PI / 2 ]]],
				E: [[ new THREE.Mesh( new THREE.TorusGeometry( 1.25, 0.1, 2, 24 ), matInvisible ) ]],
				XYZE: [[ new THREE.Mesh( new THREE.SphereGeometry( 0.7, 10, 8 ), matInvisible ) ]]
			};
			const gizmoScale = {
				X: [[ new THREE.Mesh( scaleHandleGeometry, matRed ), [ 0.8, 0, 0 ], [ 0, 0, - Math.PI / 2 ]], [ new THREE.Line( lineGeometry, matLineRed ), null, null, [ 0.8, 1, 1 ]]],
				Y: [[ new THREE.Mesh( scaleHandleGeometry, matGreen ), [ 0, 0.8, 0 ]], [ new THREE.Line( lineGeometry, matLineGreen ), null, [ 0, 0, Math.PI / 2 ], [ 0.8, 1, 1 ]]],
				Z: [[ new THREE.Mesh( scaleHandleGeometry, matBlue ), [ 0, 0, 0.8 ], [ Math.PI / 2, 0, 0 ]], [ new THREE.Line( lineGeometry, matLineBlue ), null, [ 0, - Math.PI / 2, 0 ], [ 0.8, 1, 1 ]]],
				XY: [[ new THREE.Mesh( scaleHandleGeometry, matYellowTransparent ), [ 0.85, 0.85, 0 ], null, [ 2, 2, 0.2 ]], [ new THREE.Line( lineGeometry, matLineYellow ), [ 0.855, 0.98, 0 ], null, [ 0.125, 1, 1 ]], [ new THREE.Line( lineGeometry, matLineYellow ), [ 0.98, 0.855, 0 ], [ 0, 0, Math.PI / 2 ], [ 0.125, 1, 1 ]]],
				YZ: [[ new THREE.Mesh( scaleHandleGeometry, matCyanTransparent ), [ 0, 0.85, 0.85 ], null, [ 0.2, 2, 2 ]], [ new THREE.Line( lineGeometry, matLineCyan ), [ 0, 0.855, 0.98 ], [ 0, 0, Math.PI / 2 ], [ 0.125, 1, 1 ]], [ new THREE.Line( lineGeometry, matLineCyan ), [ 0, 0.98, 0.855 ], [ 0, - Math.PI / 2, 0 ], [ 0.125, 1, 1 ]]],
				XZ: [[ new THREE.Mesh( scaleHandleGeometry, matMagentaTransparent ), [ 0.85, 0, 0.85 ], null, [ 2, 0.2, 2 ]], [ new THREE.Line( lineGeometry, matLineMagenta ), [ 0.855, 0, 0.98 ], null, [ 0.125, 1, 1 ]], [ new THREE.Line( lineGeometry, matLineMagenta ), [ 0.98, 0, 0.855 ], [ 0, - Math.PI / 2, 0 ], [ 0.125, 1, 1 ]]],
				XYZX: [[ new THREE.Mesh( new THREE.BoxGeometry( 0.125, 0.125, 0.125 ), matWhiteTransparent.clone() ), [ 1.1, 0, 0 ]]],
				XYZY: [[ new THREE.Mesh( new THREE.BoxGeometry( 0.125, 0.125, 0.125 ), matWhiteTransparent.clone() ), [ 0, 1.1, 0 ]]],
				XYZZ: [[ new THREE.Mesh( new THREE.BoxGeometry( 0.125, 0.125, 0.125 ), matWhiteTransparent.clone() ), [ 0, 0, 1.1 ]]]
			};
			const pickerScale = {
				X: [[ new THREE.Mesh( new THREE.CylinderGeometry( 0.2, 0, 0.8, 4, 1, false ), matInvisible ), [ 0.5, 0, 0 ], [ 0, 0, - Math.PI / 2 ]]],
				Y: [[ new THREE.Mesh( new THREE.CylinderGeometry( 0.2, 0, 0.8, 4, 1, false ), matInvisible ), [ 0, 0.5, 0 ]]],
				Z: [[ new THREE.Mesh( new THREE.CylinderGeometry( 0.2, 0, 0.8, 4, 1, false ), matInvisible ), [ 0, 0, 0.5 ], [ Math.PI / 2, 0, 0 ]]],
				XY: [[ new THREE.Mesh( scaleHandleGeometry, matInvisible ), [ 0.85, 0.85, 0 ], null, [ 3, 3, 0.2 ]]],
				YZ: [[ new THREE.Mesh( scaleHandleGeometry, matInvisible ), [ 0, 0.85, 0.85 ], null, [ 0.2, 3, 3 ]]],
				XZ: [[ new THREE.Mesh( scaleHandleGeometry, matInvisible ), [ 0.85, 0, 0.85 ], null, [ 3, 0.2, 3 ]]],
				XYZX: [[ new THREE.Mesh( new THREE.BoxGeometry( 0.2, 0.2, 0.2 ), matInvisible ), [ 1.1, 0, 0 ]]],
				XYZY: [[ new THREE.Mesh( new THREE.BoxGeometry( 0.2, 0.2, 0.2 ), matInvisible ), [ 0, 1.1, 0 ]]],
				XYZZ: [[ new THREE.Mesh( new THREE.BoxGeometry( 0.2, 0.2, 0.2 ), matInvisible ), [ 0, 0, 1.1 ]]]
			};
			const helperScale = {
				X: [[ new THREE.Line( lineGeometry, matHelper.clone() ), [ - 1e3, 0, 0 ], null, [ 1e6, 1, 1 ], 'helper' ]],
				Y: [[ new THREE.Line( lineGeometry, matHelper.clone() ), [ 0, - 1e3, 0 ], [ 0, 0, Math.PI / 2 ], [ 1e6, 1, 1 ], 'helper' ]],
				Z: [[ new THREE.Line( lineGeometry, matHelper.clone() ), [ 0, 0, - 1e3 ], [ 0, - Math.PI / 2, 0 ], [ 1e6, 1, 1 ], 'helper' ]]
			}; // Creates an THREE.Object3D with gizmos described in custom hierarchy definition.

			function setupGizmo( gizmoMap ) {

				const gizmo = new THREE.Object3D();

				for ( const name in gizmoMap ) {

					for ( let i = gizmoMap[ name ].length; i --; ) {

						const object = gizmoMap[ name ][ i ][ 0 ].clone();
						const position = gizmoMap[ name ][ i ][ 1 ];
						const rotation = gizmoMap[ name ][ i ][ 2 ];
						const scale = gizmoMap[ name ][ i ][ 3 ];
						const tag = gizmoMap[ name ][ i ][ 4 ]; // name and tag properties are essential for picking and updating logic.

						object.name = name;
						object.tag = tag;

						if ( position ) {

							object.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );

						}

						if ( rotation ) {

							object.rotation.set( rotation[ 0 ], rotation[ 1 ], rotation[ 2 ] );

						}

						if ( scale ) {

							object.scale.set( scale[ 0 ], scale[ 1 ], scale[ 2 ] );

						}

						object.updateMatrix();
						const tempGeometry = object.geometry.clone();
						tempGeometry.applyMatrix4( object.matrix );
						object.geometry = tempGeometry;
						object.renderOrder = Infinity;
						object.position.set( 0, 0, 0 );
						object.rotation.set( 0, 0, 0 );
						object.scale.set( 1, 1, 1 );
						gizmo.add( object );

					}

				}

				return gizmo;

			} // Gizmo creation


			this.gizmo = {};
			this.picker = {};
			this.helper = {};
			this.add( this.gizmo[ 'translate' ] = setupGizmo( gizmoTranslate ) );
			this.add( this.gizmo[ 'rotate' ] = setupGizmo( gizmoRotate ) );
			this.add( this.gizmo[ 'scale' ] = setupGizmo( gizmoScale ) );
			this.add( this.picker[ 'translate' ] = setupGizmo( pickerTranslate ) );
			this.add( this.picker[ 'rotate' ] = setupGizmo( pickerRotate ) );
			this.add( this.picker[ 'scale' ] = setupGizmo( pickerScale ) );
			this.add( this.helper[ 'translate' ] = setupGizmo( helperTranslate ) );
			this.add( this.helper[ 'rotate' ] = setupGizmo( helperRotate ) );
			this.add( this.helper[ 'scale' ] = setupGizmo( helperScale ) ); // Pickers should be hidden always

			this.picker[ 'translate' ].visible = false;
			this.picker[ 'rotate' ].visible = false;
			this.picker[ 'scale' ].visible = false;

		} // updateMatrixWorld will update transformations and appearance of individual handles


		updateMatrixWorld( force ) {

			const space = this.mode === 'scale' ? this.space : 'local'; // scale always oriented to local rotation

			const quaternion = space === 'local' ? this.worldQuaternion : _identityQuaternion; // Show only gizmos for current transform mode

			this.gizmo[ 'translate' ].visible = this.mode === 'translate';
			this.gizmo[ 'rotate' ].visible = this.mode === 'rotate';
			this.gizmo[ 'scale' ].visible = this.mode === 'scale';
			this.helper[ 'translate' ].visible = this.mode === 'translate';
			this.helper[ 'rotate' ].visible = this.mode === 'rotate';
			this.helper[ 'scale' ].visible = this.mode === 'scale';
			let handles = [];
			handles = handles.concat( this.picker[ this.mode ].children );
			handles = handles.concat( this.gizmo[ this.mode ].children );
			handles = handles.concat( this.helper[ this.mode ].children );

			for ( let i = 0; i < handles.length; i ++ ) {

				const handle = handles[ i ]; // hide aligned to camera

				handle.visible = true;
				handle.rotation.set( 0, 0, 0 );
				handle.position.copy( this.worldPosition );
				let factor;

				if ( this.camera.isOrthographicCamera ) {

					factor = ( this.camera.top - this.camera.bottom ) / this.camera.zoom;

				} else {

					factor = this.worldPosition.distanceTo( this.cameraPosition ) * Math.min( 1.9 * Math.tan( Math.PI * this.camera.fov / 360 ) / this.camera.zoom, 7 );

				}

				handle.scale.set( 1, 1, 1 ).multiplyScalar( factor * this.size / 7 ); // TODO: simplify helpers and consider decoupling from gizmo

				if ( handle.tag === 'helper' ) {

					handle.visible = false;

					if ( handle.name === 'AXIS' ) {

						handle.position.copy( this.worldPositionStart );
						handle.visible = !! this.axis;

						if ( this.axis === 'X' ) {

							_tempQuaternion.setFromEuler( _tempEuler.set( 0, 0, 0 ) );

							handle.quaternion.copy( quaternion ).multiply( _tempQuaternion );

							if ( Math.abs( _alignVector.copy( _unitX ).applyQuaternion( quaternion ).dot( this.eye ) ) > 0.9 ) {

								handle.visible = false;

							}

						}

						if ( this.axis === 'Y' ) {

							_tempQuaternion.setFromEuler( _tempEuler.set( 0, 0, Math.PI / 2 ) );

							handle.quaternion.copy( quaternion ).multiply( _tempQuaternion );

							if ( Math.abs( _alignVector.copy( _unitY ).applyQuaternion( quaternion ).dot( this.eye ) ) > 0.9 ) {

								handle.visible = false;

							}

						}

						if ( this.axis === 'Z' ) {

							_tempQuaternion.setFromEuler( _tempEuler.set( 0, Math.PI / 2, 0 ) );

							handle.quaternion.copy( quaternion ).multiply( _tempQuaternion );

							if ( Math.abs( _alignVector.copy( _unitZ ).applyQuaternion( quaternion ).dot( this.eye ) ) > 0.9 ) {

								handle.visible = false;

							}

						}

						if ( this.axis === 'XYZE' ) {

							_tempQuaternion.setFromEuler( _tempEuler.set( 0, Math.PI / 2, 0 ) );

							_alignVector.copy( this.rotationAxis );

							handle.quaternion.setFromRotationMatrix( _lookAtMatrix.lookAt( _zeroVector, _alignVector, _unitY ) );
							handle.quaternion.multiply( _tempQuaternion );
							handle.visible = this.dragging;

						}

						if ( this.axis === 'E' ) {

							handle.visible = false;

						}

					} else if ( handle.name === 'START' ) {

						handle.position.copy( this.worldPositionStart );
						handle.visible = this.dragging;

					} else if ( handle.name === 'END' ) {

						handle.position.copy( this.worldPosition );
						handle.visible = this.dragging;

					} else if ( handle.name === 'DELTA' ) {

						handle.position.copy( this.worldPositionStart );
						handle.quaternion.copy( this.worldQuaternionStart );

						_tempVector.set( 1e-10, 1e-10, 1e-10 ).add( this.worldPositionStart ).sub( this.worldPosition ).multiplyScalar( - 1 );

						_tempVector.applyQuaternion( this.worldQuaternionStart.clone().invert() );

						handle.scale.copy( _tempVector );
						handle.visible = this.dragging;

					} else {

						handle.quaternion.copy( quaternion );

						if ( this.dragging ) {

							handle.position.copy( this.worldPositionStart );

						} else {

							handle.position.copy( this.worldPosition );

						}

						if ( this.axis ) {

							handle.visible = this.axis.search( handle.name ) !== - 1;

						}

					} // If updating helper, skip rest of the loop


					continue;

				} // Align handles to current local or world rotation


				handle.quaternion.copy( quaternion );

				if ( this.mode === 'translate' || this.mode === 'scale' ) {

					// Hide translate and scale axis facing the camera
					const AXIS_HIDE_TRESHOLD = 0.99;
					const PLANE_HIDE_TRESHOLD = 0.2;
					const AXIS_FLIP_TRESHOLD = 0.0;

					if ( handle.name === 'X' || handle.name === 'XYZX' ) {

						if ( Math.abs( _alignVector.copy( _unitX ).applyQuaternion( quaternion ).dot( this.eye ) ) > AXIS_HIDE_TRESHOLD ) {

							handle.scale.set( 1e-10, 1e-10, 1e-10 );
							handle.visible = false;

						}

					}

					if ( handle.name === 'Y' || handle.name === 'XYZY' ) {

						if ( Math.abs( _alignVector.copy( _unitY ).applyQuaternion( quaternion ).dot( this.eye ) ) > AXIS_HIDE_TRESHOLD ) {

							handle.scale.set( 1e-10, 1e-10, 1e-10 );
							handle.visible = false;

						}

					}

					if ( handle.name === 'Z' || handle.name === 'XYZZ' ) {

						if ( Math.abs( _alignVector.copy( _unitZ ).applyQuaternion( quaternion ).dot( this.eye ) ) > AXIS_HIDE_TRESHOLD ) {

							handle.scale.set( 1e-10, 1e-10, 1e-10 );
							handle.visible = false;

						}

					}

					if ( handle.name === 'XY' ) {

						if ( Math.abs( _alignVector.copy( _unitZ ).applyQuaternion( quaternion ).dot( this.eye ) ) < PLANE_HIDE_TRESHOLD ) {

							handle.scale.set( 1e-10, 1e-10, 1e-10 );
							handle.visible = false;

						}

					}

					if ( handle.name === 'YZ' ) {

						if ( Math.abs( _alignVector.copy( _unitX ).applyQuaternion( quaternion ).dot( this.eye ) ) < PLANE_HIDE_TRESHOLD ) {

							handle.scale.set( 1e-10, 1e-10, 1e-10 );
							handle.visible = false;

						}

					}

					if ( handle.name === 'XZ' ) {

						if ( Math.abs( _alignVector.copy( _unitY ).applyQuaternion( quaternion ).dot( this.eye ) ) < PLANE_HIDE_TRESHOLD ) {

							handle.scale.set( 1e-10, 1e-10, 1e-10 );
							handle.visible = false;

						}

					} // Flip translate and scale axis ocluded behind another axis


					if ( handle.name.search( 'X' ) !== - 1 ) {

						if ( _alignVector.copy( _unitX ).applyQuaternion( quaternion ).dot( this.eye ) < AXIS_FLIP_TRESHOLD ) {

							if ( handle.tag === 'fwd' ) {

								handle.visible = false;

							} else {

								handle.scale.x *= - 1;

							}

						} else if ( handle.tag === 'bwd' ) {

							handle.visible = false;

						}

					}

					if ( handle.name.search( 'Y' ) !== - 1 ) {

						if ( _alignVector.copy( _unitY ).applyQuaternion( quaternion ).dot( this.eye ) < AXIS_FLIP_TRESHOLD ) {

							if ( handle.tag === 'fwd' ) {

								handle.visible = false;

							} else {

								handle.scale.y *= - 1;

							}

						} else if ( handle.tag === 'bwd' ) {

							handle.visible = false;

						}

					}

					if ( handle.name.search( 'Z' ) !== - 1 ) {

						if ( _alignVector.copy( _unitZ ).applyQuaternion( quaternion ).dot( this.eye ) < AXIS_FLIP_TRESHOLD ) {

							if ( handle.tag === 'fwd' ) {

								handle.visible = false;

							} else {

								handle.scale.z *= - 1;

							}

						} else if ( handle.tag === 'bwd' ) {

							handle.visible = false;

						}

					}

				} else if ( this.mode === 'rotate' ) {

					// Align handles to current local or world rotation
					_tempQuaternion2.copy( quaternion );

					_alignVector.copy( this.eye ).applyQuaternion( _tempQuaternion.copy( quaternion ).invert() );

					if ( handle.name.search( 'E' ) !== - 1 ) {

						handle.quaternion.setFromRotationMatrix( _lookAtMatrix.lookAt( this.eye, _zeroVector, _unitY ) );

					}

					if ( handle.name === 'X' ) {

						_tempQuaternion.setFromAxisAngle( _unitX, Math.atan2( - _alignVector.y, _alignVector.z ) );

						_tempQuaternion.multiplyQuaternions( _tempQuaternion2, _tempQuaternion );

						handle.quaternion.copy( _tempQuaternion );

					}

					if ( handle.name === 'Y' ) {

						_tempQuaternion.setFromAxisAngle( _unitY, Math.atan2( _alignVector.x, _alignVector.z ) );

						_tempQuaternion.multiplyQuaternions( _tempQuaternion2, _tempQuaternion );

						handle.quaternion.copy( _tempQuaternion );

					}

					if ( handle.name === 'Z' ) {

						_tempQuaternion.setFromAxisAngle( _unitZ, Math.atan2( _alignVector.y, _alignVector.x ) );

						_tempQuaternion.multiplyQuaternions( _tempQuaternion2, _tempQuaternion );

						handle.quaternion.copy( _tempQuaternion );

					}

				} // Hide disabled axes


				handle.visible = handle.visible && ( handle.name.indexOf( 'X' ) === - 1 || this.showX );
				handle.visible = handle.visible && ( handle.name.indexOf( 'Y' ) === - 1 || this.showY );
				handle.visible = handle.visible && ( handle.name.indexOf( 'Z' ) === - 1 || this.showZ );
				handle.visible = handle.visible && ( handle.name.indexOf( 'E' ) === - 1 || this.showX && this.showY && this.showZ ); // highlight selected axis

				handle.material._opacity = handle.material._opacity || handle.material.opacity;
				handle.material._color = handle.material._color || handle.material.color.clone();
				handle.material.color.copy( handle.material._color );
				handle.material.opacity = handle.material._opacity;

				if ( ! this.enabled ) {

					handle.material.opacity *= 0.5;
					handle.material.color.lerp( new THREE.Color( 1, 1, 1 ), 0.5 );

				} else if ( this.axis ) {

					if ( handle.name === this.axis ) {

						handle.material.opacity = 1.0;
						handle.material.color.lerp( new THREE.Color( 1, 1, 1 ), 0.5 );

					} else if ( this.axis.split( '' ).some( function ( a ) {

						return handle.name === a;

					} ) ) {

						handle.material.opacity = 1.0;
						handle.material.color.lerp( new THREE.Color( 1, 1, 1 ), 0.5 );

					} else {

						handle.material.opacity *= 0.25;
						handle.material.color.lerp( new THREE.Color( 1, 1, 1 ), 0.5 );

					}

				}

			}

			super.updateMatrixWorld( force );

		}

	}

	TransformControlsGizmo.prototype.isTransformControlsGizmo = true; //

	class TransformControlsPlane extends THREE.Mesh {

		constructor() {

			super( new THREE.PlaneGeometry( 100000, 100000, 2, 2 ), new THREE.MeshBasicMaterial( {
				visible: false,
				wireframe: true,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.1,
				toneMapped: false
			} ) );
			this.type = 'TransformControlsPlane';

		}

		updateMatrixWorld( force ) {

			let space = this.space;
			this.position.copy( this.worldPosition );
			if ( this.mode === 'scale' ) space = 'local'; // scale always oriented to local rotation

			_v1.copy( _unitX ).applyQuaternion( space === 'local' ? this.worldQuaternion : _identityQuaternion );

			_v2.copy( _unitY ).applyQuaternion( space === 'local' ? this.worldQuaternion : _identityQuaternion );

			_v3.copy( _unitZ ).applyQuaternion( space === 'local' ? this.worldQuaternion : _identityQuaternion ); // Align the plane for current transform mode, axis and space.


			_alignVector.copy( _v2 );

			switch ( this.mode ) {

				case 'translate':
				case 'scale':
					switch ( this.axis ) {

						case 'X':
							_alignVector.copy( this.eye ).cross( _v1 );

							_dirVector.copy( _v1 ).cross( _alignVector );

							break;

						case 'Y':
							_alignVector.copy( this.eye ).cross( _v2 );

							_dirVector.copy( _v2 ).cross( _alignVector );

							break;

						case 'Z':
							_alignVector.copy( this.eye ).cross( _v3 );

							_dirVector.copy( _v3 ).cross( _alignVector );

							break;

						case 'XY':
							_dirVector.copy( _v3 );

							break;

						case 'YZ':
							_dirVector.copy( _v1 );

							break;

						case 'XZ':
							_alignVector.copy( _v3 );

							_dirVector.copy( _v2 );

							break;

						case 'XYZ':
						case 'E':
							_dirVector.set( 0, 0, 0 );

							break;

					}

					break;

				case 'rotate':
				default:
					// special case for rotate
					_dirVector.set( 0, 0, 0 );

			}

			if ( _dirVector.length() === 0 ) {

				// If in rotate mode, make the plane parallel to camera
				this.quaternion.copy( this.cameraQuaternion );

			} else {

				_tempMatrix.lookAt( _tempVector.set( 0, 0, 0 ), _dirVector, _alignVector );

				this.quaternion.setFromRotationMatrix( _tempMatrix );

			}

			super.updateMatrixWorld( force );

		}

	}

	TransformControlsPlane.prototype.isTransformControlsPlane = true;

	THREE.TransformControls = TransformControls;
	THREE.TransformControlsGizmo = TransformControlsGizmo;
	THREE.TransformControlsPlane = TransformControlsPlane;

} )();

/* --- three/examples/js/controls/OrbitControls.js --- */
( function () {

	// Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).
	//
	//    Orbit - left mouse / touch: one-finger move
	//    Zoom - middle mouse, or mousewheel / touch: two-finger spread or squish
	//    Pan - right mouse, or left mouse + ctrl/meta/shiftKey, or arrow keys / touch: two-finger move

	const _changeEvent = {
		type: 'change'
	};
	const _startEvent = {
		type: 'start'
	};
	const _endEvent = {
		type: 'end'
	};

	class OrbitControls extends THREE.EventDispatcher {

		constructor( object, domElement ) {

			super();
			if ( domElement === undefined ) console.warn( 'THREE.OrbitControls: The second parameter "domElement" is now mandatory.' );
			if ( domElement === document ) console.error( 'THREE.OrbitControls: "document" should not be used as the target "domElement". Please use "renderer.domElement" instead.' );
			this.object = object;
			this.domElement = domElement; // Set to false to disable this control

			this.enabled = true; // "target" sets the location of focus, where the object orbits around

			this.target = new THREE.Vector3(); // How far you can dolly in and out ( PerspectiveCamera only )

			this.minDistance = 0;
			this.maxDistance = Infinity; // How far you can zoom in and out ( OrthographicCamera only )

			this.minZoom = 0;
			this.maxZoom = Infinity; // How far you can orbit vertically, upper and lower limits.
			// Range is 0 to Math.PI radians.

			this.minPolarAngle = 0; // radians

			this.maxPolarAngle = Math.PI; // radians
			// How far you can orbit horizontally, upper and lower limits.
			// If set, the interval [ min, max ] must be a sub-interval of [ - 2 PI, 2 PI ], with ( max - min < 2 PI )

			this.minAzimuthAngle = - Infinity; // radians

			this.maxAzimuthAngle = Infinity; // radians
			// Set to true to enable damping (inertia)
			// If damping is enabled, you must call controls.update() in your animation loop

			this.enableDamping = false;
			this.dampingFactor = 0.05; // This option actually enables dollying in and out; left as "zoom" for backwards compatibility.
			// Set to false to disable zooming

			this.enableZoom = true;
			this.zoomSpeed = 1.0; // Set to false to disable rotating

			this.enableRotate = true;
			this.rotateSpeed = 1.0; // Set to false to disable panning

			this.enablePan = true;
			this.panSpeed = 1.0;
			this.screenSpacePanning = true; // if false, pan orthogonal to world-space direction camera.up

			this.keyPanSpeed = 7.0; // pixels moved per arrow key push
			// Set to true to automatically rotate around the target
			// If auto-rotate is enabled, you must call controls.update() in your animation loop

			this.autoRotate = false;
			this.autoRotateSpeed = 2.0; // 30 seconds per orbit when fps is 60
			// The four arrow keys

			this.keys = {
				LEFT: 'ArrowLeft',
				UP: 'ArrowUp',
				RIGHT: 'ArrowRight',
				BOTTOM: 'ArrowDown'
			}; // Mouse buttons

			this.mouseButtons = {
				LEFT: THREE.MOUSE.ROTATE,
				MIDDLE: THREE.MOUSE.DOLLY,
				RIGHT: THREE.MOUSE.PAN
			}; // Touch fingers

			this.touches = {
				ONE: THREE.TOUCH.ROTATE,
				TWO: THREE.TOUCH.DOLLY_PAN
			}; // for reset

			this.target0 = this.target.clone();
			this.position0 = this.object.position.clone();
			this.zoom0 = this.object.zoom; // the target DOM element for key events

			this._domElementKeyEvents = null; //
			// public methods
			//

			this.getPolarAngle = function () {

				return spherical.phi;

			};

			this.getAzimuthalAngle = function () {

				return spherical.theta;

			};

			this.listenToKeyEvents = function ( domElement ) {

				domElement.addEventListener( 'keydown', onKeyDown );
				this._domElementKeyEvents = domElement;

			};

			this.saveState = function () {

				scope.target0.copy( scope.target );
				scope.position0.copy( scope.object.position );
				scope.zoom0 = scope.object.zoom;

			};

			this.reset = function () {

				scope.target.copy( scope.target0 );
				scope.object.position.copy( scope.position0 );
				scope.object.zoom = scope.zoom0;
				scope.object.updateProjectionMatrix();
				scope.dispatchEvent( _changeEvent );
				scope.update();
				state = STATE.NONE;

			}; // this method is exposed, but perhaps it would be better if we can make it private...


			this.update = function () {

				const offset = new THREE.Vector3(); // so camera.up is the orbit axis

				const quat = new THREE.Quaternion().setFromUnitVectors( object.up, new THREE.Vector3( 0, 1, 0 ) );
				const quatInverse = quat.clone().invert();
				const lastPosition = new THREE.Vector3();
				const lastQuaternion = new THREE.Quaternion();
				const twoPI = 2 * Math.PI;
				return function update() {

					const position = scope.object.position;
					offset.copy( position ).sub( scope.target ); // rotate offset to "y-axis-is-up" space

					offset.applyQuaternion( quat ); // angle from z-axis around y-axis

					spherical.setFromVector3( offset );

					if ( scope.autoRotate && state === STATE.NONE ) {

						rotateLeft( getAutoRotationAngle() );

					}

					if ( scope.enableDamping ) {

						spherical.theta += sphericalDelta.theta * scope.dampingFactor;
						spherical.phi += sphericalDelta.phi * scope.dampingFactor;

					} else {

						spherical.theta += sphericalDelta.theta;
						spherical.phi += sphericalDelta.phi;

					} // restrict theta to be between desired limits


					let min = scope.minAzimuthAngle;
					let max = scope.maxAzimuthAngle;

					if ( isFinite( min ) && isFinite( max ) ) {

						if ( min < - Math.PI ) min += twoPI; else if ( min > Math.PI ) min -= twoPI;
						if ( max < - Math.PI ) max += twoPI; else if ( max > Math.PI ) max -= twoPI;

						if ( min <= max ) {

							spherical.theta = Math.max( min, Math.min( max, spherical.theta ) );

						} else {

							spherical.theta = spherical.theta > ( min + max ) / 2 ? Math.max( min, spherical.theta ) : Math.min( max, spherical.theta );

						}

					} // restrict phi to be between desired limits


					spherical.phi = Math.max( scope.minPolarAngle, Math.min( scope.maxPolarAngle, spherical.phi ) );
					spherical.makeSafe();
					spherical.radius *= scale; // restrict radius to be between desired limits

					spherical.radius = Math.max( scope.minDistance, Math.min( scope.maxDistance, spherical.radius ) ); // move target to panned location

					if ( scope.enableDamping === true ) {

						scope.target.addScaledVector( panOffset, scope.dampingFactor );

					} else {

						scope.target.add( panOffset );

					}

					offset.setFromSpherical( spherical ); // rotate offset back to "camera-up-vector-is-up" space

					offset.applyQuaternion( quatInverse );
					position.copy( scope.target ).add( offset );
					scope.object.lookAt( scope.target );

					if ( scope.enableDamping === true ) {

						sphericalDelta.theta *= 1 - scope.dampingFactor;
						sphericalDelta.phi *= 1 - scope.dampingFactor;
						panOffset.multiplyScalar( 1 - scope.dampingFactor );

					} else {

						sphericalDelta.set( 0, 0, 0 );
						panOffset.set( 0, 0, 0 );

					}

					scale = 1; // update condition is:
					// min(camera displacement, camera rotation in radians)^2 > EPS
					// using small-angle approximation cos(x/2) = 1 - x^2 / 8

					if ( zoomChanged || lastPosition.distanceToSquared( scope.object.position ) > EPS || 8 * ( 1 - lastQuaternion.dot( scope.object.quaternion ) ) > EPS ) {

						scope.dispatchEvent( _changeEvent );
						lastPosition.copy( scope.object.position );
						lastQuaternion.copy( scope.object.quaternion );
						zoomChanged = false;
						return true;

					}

					return false;

				};

			}();

			this.dispose = function () {

				scope.domElement.removeEventListener( 'contextmenu', onContextMenu );
				scope.domElement.removeEventListener( 'pointerdown', onPointerDown );
				scope.domElement.removeEventListener( 'wheel', onMouseWheel );
				scope.domElement.removeEventListener( 'touchstart', onTouchStart );
				scope.domElement.removeEventListener( 'touchend', onTouchEnd );
				scope.domElement.removeEventListener( 'touchmove', onTouchMove );
				scope.domElement.ownerDocument.removeEventListener( 'pointermove', onPointerMove );
				scope.domElement.ownerDocument.removeEventListener( 'pointerup', onPointerUp );

				if ( scope._domElementKeyEvents !== null ) {

					scope._domElementKeyEvents.removeEventListener( 'keydown', onKeyDown );

				} //scope.dispatchEvent( { type: 'dispose' } ); // should this be added here?

			}; //
			// internals
			//


			const scope = this;
			const STATE = {
				NONE: - 1,
				ROTATE: 0,
				DOLLY: 1,
				PAN: 2,
				TOUCH_ROTATE: 3,
				TOUCH_PAN: 4,
				TOUCH_DOLLY_PAN: 5,
				TOUCH_DOLLY_ROTATE: 6
			};
			let state = STATE.NONE;
			const EPS = 0.000001; // current position in spherical coordinates

			const spherical = new THREE.Spherical();
			const sphericalDelta = new THREE.Spherical();
			let scale = 1;
			const panOffset = new THREE.Vector3();
			let zoomChanged = false;
			const rotateStart = new THREE.Vector2();
			const rotateEnd = new THREE.Vector2();
			const rotateDelta = new THREE.Vector2();
			const panStart = new THREE.Vector2();
			const panEnd = new THREE.Vector2();
			const panDelta = new THREE.Vector2();
			const dollyStart = new THREE.Vector2();
			const dollyEnd = new THREE.Vector2();
			const dollyDelta = new THREE.Vector2();

			function getAutoRotationAngle() {

				return 2 * Math.PI / 60 / 60 * scope.autoRotateSpeed;

			}

			function getZoomScale() {

				return Math.pow( 0.95, scope.zoomSpeed );

			}

			function rotateLeft( angle ) {

				sphericalDelta.theta -= angle;

			}

			function rotateUp( angle ) {

				sphericalDelta.phi -= angle;

			}

			const panLeft = function () {

				const v = new THREE.Vector3();
				return function panLeft( distance, objectMatrix ) {

					v.setFromMatrixColumn( objectMatrix, 0 ); // get X column of objectMatrix

					v.multiplyScalar( - distance );
					panOffset.add( v );

				};

			}();

			const panUp = function () {

				const v = new THREE.Vector3();
				return function panUp( distance, objectMatrix ) {

					if ( scope.screenSpacePanning === true ) {

						v.setFromMatrixColumn( objectMatrix, 1 );

					} else {

						v.setFromMatrixColumn( objectMatrix, 0 );
						v.crossVectors( scope.object.up, v );

					}

					v.multiplyScalar( distance );
					panOffset.add( v );

				};

			}(); // deltaX and deltaY are in pixels; right and down are positive


			const pan = function () {

				const offset = new THREE.Vector3();
				return function pan( deltaX, deltaY ) {

					const element = scope.domElement;

					if ( scope.object.isPerspectiveCamera ) {

						// perspective
						const position = scope.object.position;
						offset.copy( position ).sub( scope.target );
						let targetDistance = offset.length(); // half of the fov is center to top of screen

						targetDistance *= Math.tan( scope.object.fov / 2 * Math.PI / 180.0 ); // we use only clientHeight here so aspect ratio does not distort speed

						panLeft( 2 * deltaX * targetDistance / element.clientHeight, scope.object.matrix );
						panUp( 2 * deltaY * targetDistance / element.clientHeight, scope.object.matrix );

					} else if ( scope.object.isOrthographicCamera ) {

						// orthographic
						panLeft( deltaX * ( scope.object.right - scope.object.left ) / scope.object.zoom / element.clientWidth, scope.object.matrix );
						panUp( deltaY * ( scope.object.top - scope.object.bottom ) / scope.object.zoom / element.clientHeight, scope.object.matrix );

					} else {

						// camera neither orthographic nor perspective
						console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - pan disabled.' );
						scope.enablePan = false;

					}

				};

			}();

			function dollyOut( dollyScale ) {

				if ( scope.object.isPerspectiveCamera ) {

					scale /= dollyScale;

				} else if ( scope.object.isOrthographicCamera ) {

					scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom * dollyScale ) );
					scope.object.updateProjectionMatrix();
					zoomChanged = true;

				} else {

					console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
					scope.enableZoom = false;

				}

			}

			function dollyIn( dollyScale ) {

				if ( scope.object.isPerspectiveCamera ) {

					scale *= dollyScale;

				} else if ( scope.object.isOrthographicCamera ) {

					scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom / dollyScale ) );
					scope.object.updateProjectionMatrix();
					zoomChanged = true;

				} else {

					console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
					scope.enableZoom = false;

				}

			} //
			// event callbacks - update the object state
			//


			function handleMouseDownRotate( event ) {

				rotateStart.set( event.clientX, event.clientY );

			}

			function handleMouseDownDolly( event ) {

				dollyStart.set( event.clientX, event.clientY );

			}

			function handleMouseDownPan( event ) {

				panStart.set( event.clientX, event.clientY );

			}

			function handleMouseMoveRotate( event ) {

				rotateEnd.set( event.clientX, event.clientY );
				rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );
				const element = scope.domElement;
				rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight ); // yes, height

				rotateUp( 2 * Math.PI * rotateDelta.y / element.clientHeight );
				rotateStart.copy( rotateEnd );
				scope.update();

			}

			function handleMouseMoveDolly( event ) {

				dollyEnd.set( event.clientX, event.clientY );
				dollyDelta.subVectors( dollyEnd, dollyStart );

				if ( dollyDelta.y > 0 ) {

					dollyOut( getZoomScale() );

				} else if ( dollyDelta.y < 0 ) {

					dollyIn( getZoomScale() );

				}

				dollyStart.copy( dollyEnd );
				scope.update();

			}

			function handleMouseMovePan( event ) {

				panEnd.set( event.clientX, event.clientY );
				panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );
				pan( panDelta.x, panDelta.y );
				panStart.copy( panEnd );
				scope.update();

			}

			function handleMouseUp( ) { // no-op
			}

			function handleMouseWheel( event ) {

				if ( event.deltaY < 0 ) {

					dollyIn( getZoomScale() );

				} else if ( event.deltaY > 0 ) {

					dollyOut( getZoomScale() );

				}

				scope.update();

			}

			function handleKeyDown( event ) {

				let needsUpdate = false;

				switch ( event.code ) {

					case scope.keys.UP:
						pan( 0, scope.keyPanSpeed );
						needsUpdate = true;
						break;

					case scope.keys.BOTTOM:
						pan( 0, - scope.keyPanSpeed );
						needsUpdate = true;
						break;

					case scope.keys.LEFT:
						pan( scope.keyPanSpeed, 0 );
						needsUpdate = true;
						break;

					case scope.keys.RIGHT:
						pan( - scope.keyPanSpeed, 0 );
						needsUpdate = true;
						break;

				}

				if ( needsUpdate ) {

					// prevent the browser from scrolling on cursor keys
					event.preventDefault();
					scope.update();

				}

			}

			function handleTouchStartRotate( event ) {

				if ( event.touches.length == 1 ) {

					rotateStart.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );

				} else {

					const x = 0.5 * ( event.touches[ 0 ].pageX + event.touches[ 1 ].pageX );
					const y = 0.5 * ( event.touches[ 0 ].pageY + event.touches[ 1 ].pageY );
					rotateStart.set( x, y );

				}

			}

			function handleTouchStartPan( event ) {

				if ( event.touches.length == 1 ) {

					panStart.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );

				} else {

					const x = 0.5 * ( event.touches[ 0 ].pageX + event.touches[ 1 ].pageX );
					const y = 0.5 * ( event.touches[ 0 ].pageY + event.touches[ 1 ].pageY );
					panStart.set( x, y );

				}

			}

			function handleTouchStartDolly( event ) {

				const dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
				const dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;
				const distance = Math.sqrt( dx * dx + dy * dy );
				dollyStart.set( 0, distance );

			}

			function handleTouchStartDollyPan( event ) {

				if ( scope.enableZoom ) handleTouchStartDolly( event );
				if ( scope.enablePan ) handleTouchStartPan( event );

			}

			function handleTouchStartDollyRotate( event ) {

				if ( scope.enableZoom ) handleTouchStartDolly( event );
				if ( scope.enableRotate ) handleTouchStartRotate( event );

			}

			function handleTouchMoveRotate( event ) {

				if ( event.touches.length == 1 ) {

					rotateEnd.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );

				} else {

					const x = 0.5 * ( event.touches[ 0 ].pageX + event.touches[ 1 ].pageX );
					const y = 0.5 * ( event.touches[ 0 ].pageY + event.touches[ 1 ].pageY );
					rotateEnd.set( x, y );

				}

				rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );
				const element = scope.domElement;
				rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight ); // yes, height

				rotateUp( 2 * Math.PI * rotateDelta.y / element.clientHeight );
				rotateStart.copy( rotateEnd );

			}

			function handleTouchMovePan( event ) {

				if ( event.touches.length == 1 ) {

					panEnd.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );

				} else {

					const x = 0.5 * ( event.touches[ 0 ].pageX + event.touches[ 1 ].pageX );
					const y = 0.5 * ( event.touches[ 0 ].pageY + event.touches[ 1 ].pageY );
					panEnd.set( x, y );

				}

				panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );
				pan( panDelta.x, panDelta.y );
				panStart.copy( panEnd );

			}

			function handleTouchMoveDolly( event ) {

				const dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
				const dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;
				const distance = Math.sqrt( dx * dx + dy * dy );
				dollyEnd.set( 0, distance );
				dollyDelta.set( 0, Math.pow( dollyEnd.y / dollyStart.y, scope.zoomSpeed ) );
				dollyOut( dollyDelta.y );
				dollyStart.copy( dollyEnd );

			}

			function handleTouchMoveDollyPan( event ) {

				if ( scope.enableZoom ) handleTouchMoveDolly( event );
				if ( scope.enablePan ) handleTouchMovePan( event );

			}

			function handleTouchMoveDollyRotate( event ) {

				if ( scope.enableZoom ) handleTouchMoveDolly( event );
				if ( scope.enableRotate ) handleTouchMoveRotate( event );

			}

			function handleTouchEnd( ) { // no-op
			} //
			// event handlers - FSM: listen for events and reset state
			//


			function onPointerDown( event ) {

				if ( scope.enabled === false ) return;

				switch ( event.pointerType ) {

					case 'mouse':
					case 'pen':
						onMouseDown( event );
						break;
        // TODO touch

				}

			}

			function onPointerMove( event ) {

				if ( scope.enabled === false ) return;

				switch ( event.pointerType ) {

					case 'mouse':
					case 'pen':
						onMouseMove( event );
						break;
        // TODO touch

				}

			}

			function onPointerUp( event ) {

				switch ( event.pointerType ) {

					case 'mouse':
					case 'pen':
						onMouseUp( event );
						break;
        // TODO touch

				}

			}

			function onMouseDown( event ) {

				// Prevent the browser from scrolling.
				event.preventDefault(); // Manually set the focus since calling preventDefault above
				// prevents the browser from setting it automatically.

				scope.domElement.focus ? scope.domElement.focus() : window.focus();
				let mouseAction;

				switch ( event.button ) {

					case 0:
						mouseAction = scope.mouseButtons.LEFT;
						break;

					case 1:
						mouseAction = scope.mouseButtons.MIDDLE;
						break;

					case 2:
						mouseAction = scope.mouseButtons.RIGHT;
						break;

					default:
						mouseAction = - 1;

				}

				switch ( mouseAction ) {

					case THREE.MOUSE.DOLLY:
						if ( scope.enableZoom === false ) return;
						handleMouseDownDolly( event );
						state = STATE.DOLLY;
						break;

					case THREE.MOUSE.ROTATE:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							if ( scope.enablePan === false ) return;
							handleMouseDownPan( event );
							state = STATE.PAN;

						} else {

							if ( scope.enableRotate === false ) return;
							handleMouseDownRotate( event );
							state = STATE.ROTATE;

						}

						break;

					case THREE.MOUSE.PAN:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							if ( scope.enableRotate === false ) return;
							handleMouseDownRotate( event );
							state = STATE.ROTATE;

						} else {

							if ( scope.enablePan === false ) return;
							handleMouseDownPan( event );
							state = STATE.PAN;

						}

						break;

					default:
						state = STATE.NONE;

				}

				if ( state !== STATE.NONE ) {

					scope.domElement.ownerDocument.addEventListener( 'pointermove', onPointerMove );
					scope.domElement.ownerDocument.addEventListener( 'pointerup', onPointerUp );
					scope.dispatchEvent( _startEvent );

				}

			}

			function onMouseMove( event ) {

				if ( scope.enabled === false ) return;
				event.preventDefault();

				switch ( state ) {

					case STATE.ROTATE:
						if ( scope.enableRotate === false ) return;
						handleMouseMoveRotate( event );
						break;

					case STATE.DOLLY:
						if ( scope.enableZoom === false ) return;
						handleMouseMoveDolly( event );
						break;

					case STATE.PAN:
						if ( scope.enablePan === false ) return;
						handleMouseMovePan( event );
						break;

				}

			}

			function onMouseUp( event ) {

				scope.domElement.ownerDocument.removeEventListener( 'pointermove', onPointerMove );
				scope.domElement.ownerDocument.removeEventListener( 'pointerup', onPointerUp );
				if ( scope.enabled === false ) return;
				handleMouseUp( event );
				scope.dispatchEvent( _endEvent );
				state = STATE.NONE;

			}

			function onMouseWheel( event ) {

				if ( scope.enabled === false || scope.enableZoom === false || state !== STATE.NONE && state !== STATE.ROTATE ) return;
				event.preventDefault();
				scope.dispatchEvent( _startEvent );
				handleMouseWheel( event );
				scope.dispatchEvent( _endEvent );

			}

			function onKeyDown( event ) {

				if ( scope.enabled === false || scope.enablePan === false ) return;
				handleKeyDown( event );

			}

			function onTouchStart( event ) {

				if ( scope.enabled === false ) return;
				event.preventDefault(); // prevent scrolling

				switch ( event.touches.length ) {

					case 1:
						switch ( scope.touches.ONE ) {

							case THREE.TOUCH.ROTATE:
								if ( scope.enableRotate === false ) return;
								handleTouchStartRotate( event );
								state = STATE.TOUCH_ROTATE;
								break;

							case THREE.TOUCH.PAN:
								if ( scope.enablePan === false ) return;
								handleTouchStartPan( event );
								state = STATE.TOUCH_PAN;
								break;

							default:
								state = STATE.NONE;

						}

						break;

					case 2:
						switch ( scope.touches.TWO ) {

							case THREE.TOUCH.DOLLY_PAN:
								if ( scope.enableZoom === false && scope.enablePan === false ) return;
								handleTouchStartDollyPan( event );
								state = STATE.TOUCH_DOLLY_PAN;
								break;

							case THREE.TOUCH.DOLLY_ROTATE:
								if ( scope.enableZoom === false && scope.enableRotate === false ) return;
								handleTouchStartDollyRotate( event );
								state = STATE.TOUCH_DOLLY_ROTATE;
								break;

							default:
								state = STATE.NONE;

						}

						break;

					default:
						state = STATE.NONE;

				}

				if ( state !== STATE.NONE ) {

					scope.dispatchEvent( _startEvent );

				}

			}

			function onTouchMove( event ) {

				if ( scope.enabled === false ) return;
				event.preventDefault(); // prevent scrolling

				switch ( state ) {

					case STATE.TOUCH_ROTATE:
						if ( scope.enableRotate === false ) return;
						handleTouchMoveRotate( event );
						scope.update();
						break;

					case STATE.TOUCH_PAN:
						if ( scope.enablePan === false ) return;
						handleTouchMovePan( event );
						scope.update();
						break;

					case STATE.TOUCH_DOLLY_PAN:
						if ( scope.enableZoom === false && scope.enablePan === false ) return;
						handleTouchMoveDollyPan( event );
						scope.update();
						break;

					case STATE.TOUCH_DOLLY_ROTATE:
						if ( scope.enableZoom === false && scope.enableRotate === false ) return;
						handleTouchMoveDollyRotate( event );
						scope.update();
						break;

					default:
						state = STATE.NONE;

				}

			}

			function onTouchEnd( event ) {

				if ( scope.enabled === false ) return;
				handleTouchEnd( event );
				scope.dispatchEvent( _endEvent );
				state = STATE.NONE;

			}

			function onContextMenu( event ) {

				if ( scope.enabled === false ) return;
				event.preventDefault();

			} //


			scope.domElement.addEventListener( 'contextmenu', onContextMenu );
			scope.domElement.addEventListener( 'pointerdown', onPointerDown );
			scope.domElement.addEventListener( 'wheel', onMouseWheel, {
				passive: false
			} );
			scope.domElement.addEventListener( 'touchstart', onTouchStart, {
				passive: false
			} );
			scope.domElement.addEventListener( 'touchend', onTouchEnd );
			scope.domElement.addEventListener( 'touchmove', onTouchMove, {
				passive: false
			} ); // force an update at start

			this.update();

		}

	} // This set of controls performs orbiting, dollying (zooming), and panning.
	// Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).
	// This is very similar to OrbitControls, another set of touch behavior
	//
	//    Orbit - right mouse, or left mouse + ctrl/meta/shiftKey / touch: two-finger rotate
	//    Zoom - middle mouse, or mousewheel / touch: two-finger spread or squish
	//    Pan - left mouse, or arrow keys / touch: one-finger move


	class MapControls extends OrbitControls {

		constructor( object, domElement ) {

			super( object, domElement );
			this.screenSpacePanning = false; // pan orthogonal to world-space direction camera.up

			this.mouseButtons.LEFT = THREE.MOUSE.PAN;
			this.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
			this.touches.ONE = THREE.TOUCH.PAN;
			this.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

		}

	}

	THREE.MapControls = MapControls;
	THREE.OrbitControls = OrbitControls;

} )();

/* --- three/examples/js/loaders/GLTFLoader.js --- */
( function () {

	class GLTFLoader extends THREE.Loader {

		constructor( manager ) {

			super( manager );
			this.dracoLoader = null;
			this.ktx2Loader = null;
			this.meshoptDecoder = null;
			this.pluginCallbacks = [];
			this.register( function ( parser ) {

				return new GLTFMaterialsClearcoatExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFTextureBasisUExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFTextureWebPExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsTransmissionExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFLightsExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMeshoptCompression( parser );

			} );

		}

		load( url, onLoad, onProgress, onError ) {

			const scope = this;
			let resourcePath;

			if ( this.resourcePath !== '' ) {

				resourcePath = this.resourcePath;

			} else if ( this.path !== '' ) {

				resourcePath = this.path;

			} else {

				resourcePath = THREE.LoaderUtils.extractUrlBase( url );

			} // Tells the LoadingManager to track an extra item, which resolves after
			// the model is fully loaded. This means the count of items loaded will
			// be incorrect, but ensures manager.onLoad() does not fire early.


			this.manager.itemStart( url );

			const _onError = function ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				scope.manager.itemError( url );
				scope.manager.itemEnd( url );

			};

			const loader = new THREE.FileLoader( this.manager );
			loader.setPath( this.path );
			loader.setResponseType( 'arraybuffer' );
			loader.setRequestHeader( this.requestHeader );
			loader.setWithCredentials( this.withCredentials );
			loader.load( url, function ( data ) {

				try {

					scope.parse( data, resourcePath, function ( gltf ) {

						onLoad( gltf );
						scope.manager.itemEnd( url );

					}, _onError );

				} catch ( e ) {

					_onError( e );

				}

			}, onProgress, _onError );

		}

		setDRACOLoader( dracoLoader ) {

			this.dracoLoader = dracoLoader;
			return this;

		}

		setDDSLoader() {

			throw new Error( 'THREE.GLTFLoader: "MSFT_texture_dds" no longer supported. Please update to "KHR_texture_basisu".' );

		}

		setKTX2Loader( ktx2Loader ) {

			this.ktx2Loader = ktx2Loader;
			return this;

		}

		setMeshoptDecoder( meshoptDecoder ) {

			this.meshoptDecoder = meshoptDecoder;
			return this;

		}

		register( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) === - 1 ) {

				this.pluginCallbacks.push( callback );

			}

			return this;

		}

		unregister( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) !== - 1 ) {

				this.pluginCallbacks.splice( this.pluginCallbacks.indexOf( callback ), 1 );

			}

			return this;

		}

		parse( data, path, onLoad, onError ) {

			let content;
			const extensions = {};
			const plugins = {};

			if ( typeof data === 'string' ) {

				content = data;

			} else {

				const magic = THREE.LoaderUtils.decodeText( new Uint8Array( data, 0, 4 ) );

				if ( magic === BINARY_EXTENSION_HEADER_MAGIC ) {

					try {

						extensions[ EXTENSIONS.KHR_BINARY_GLTF ] = new GLTFBinaryExtension( data );

					} catch ( error ) {

						if ( onError ) onError( error );
						return;

					}

					content = extensions[ EXTENSIONS.KHR_BINARY_GLTF ].content;

				} else {

					content = THREE.LoaderUtils.decodeText( new Uint8Array( data ) );

				}

			}

			const json = JSON.parse( content );

			if ( json.asset === undefined || json.asset.version[ 0 ] < 2 ) {

				if ( onError ) onError( new Error( 'THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.' ) );
				return;

			}

			const parser = new GLTFParser( json, {
				path: path || this.resourcePath || '',
				crossOrigin: this.crossOrigin,
				requestHeader: this.requestHeader,
				manager: this.manager,
				ktx2Loader: this.ktx2Loader,
				meshoptDecoder: this.meshoptDecoder
			} );
			parser.fileLoader.setRequestHeader( this.requestHeader );

			for ( let i = 0; i < this.pluginCallbacks.length; i ++ ) {

				const plugin = this.pluginCallbacks[ i ]( parser );
				plugins[ plugin.name ] = plugin; // Workaround to avoid determining as unknown extension
				// in addUnknownExtensionsToUserData().
				// Remove this workaround if we move all the existing
				// extension handlers to plugin system

				extensions[ plugin.name ] = true;

			}

			if ( json.extensionsUsed ) {

				for ( let i = 0; i < json.extensionsUsed.length; ++ i ) {

					const extensionName = json.extensionsUsed[ i ];
					const extensionsRequired = json.extensionsRequired || [];

					switch ( extensionName ) {

						case EXTENSIONS.KHR_MATERIALS_UNLIT:
							extensions[ extensionName ] = new GLTFMaterialsUnlitExtension();
							break;

						case EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS:
							extensions[ extensionName ] = new GLTFMaterialsPbrSpecularGlossinessExtension();
							break;

						case EXTENSIONS.KHR_DRACO_MESH_COMPRESSION:
							extensions[ extensionName ] = new GLTFDracoMeshCompressionExtension( json, this.dracoLoader );
							break;

						case EXTENSIONS.KHR_TEXTURE_TRANSFORM:
							extensions[ extensionName ] = new GLTFTextureTransformExtension();
							break;

						case EXTENSIONS.KHR_MESH_QUANTIZATION:
							extensions[ extensionName ] = new GLTFMeshQuantizationExtension();
							break;

						default:
							if ( extensionsRequired.indexOf( extensionName ) >= 0 && plugins[ extensionName ] === undefined ) {

								console.warn( 'THREE.GLTFLoader: Unknown extension "' + extensionName + '".' );

							}

					}

				}

			}

			parser.setExtensions( extensions );
			parser.setPlugins( plugins );
			parser.parse( onLoad, onError );

		}

	}
	/* GLTFREGISTRY */


	function GLTFRegistry() {

		let objects = {};
		return {
			get: function ( key ) {

				return objects[ key ];

			},
			add: function ( key, object ) {

				objects[ key ] = object;

			},
			remove: function ( key ) {

				delete objects[ key ];

			},
			removeAll: function () {

				objects = {};

			}
		};

	}
	/*********************************/

	/********** EXTENSIONS ***********/

	/*********************************/


	const EXTENSIONS = {
		KHR_BINARY_GLTF: 'KHR_binary_glTF',
		KHR_DRACO_MESH_COMPRESSION: 'KHR_draco_mesh_compression',
		KHR_LIGHTS_PUNCTUAL: 'KHR_lights_punctual',
		KHR_MATERIALS_CLEARCOAT: 'KHR_materials_clearcoat',
		KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS: 'KHR_materials_pbrSpecularGlossiness',
		KHR_MATERIALS_TRANSMISSION: 'KHR_materials_transmission',
		KHR_MATERIALS_UNLIT: 'KHR_materials_unlit',
		KHR_TEXTURE_BASISU: 'KHR_texture_basisu',
		KHR_TEXTURE_TRANSFORM: 'KHR_texture_transform',
		KHR_MESH_QUANTIZATION: 'KHR_mesh_quantization',
		EXT_TEXTURE_WEBP: 'EXT_texture_webp',
		EXT_MESHOPT_COMPRESSION: 'EXT_meshopt_compression'
	};
	/**
	 * Punctual Lights Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_lights_punctual
	 */

	class GLTFLightsExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_LIGHTS_PUNCTUAL; // THREE.Object3D instance caches

			this.cache = {
				refs: {},
				uses: {}
			};

		}

		_markDefs() {

			const parser = this.parser;
			const nodeDefs = this.parser.json.nodes || [];

			for ( let nodeIndex = 0, nodeLength = nodeDefs.length; nodeIndex < nodeLength; nodeIndex ++ ) {

				const nodeDef = nodeDefs[ nodeIndex ];

				if ( nodeDef.extensions && nodeDef.extensions[ this.name ] && nodeDef.extensions[ this.name ].light !== undefined ) {

					parser._addNodeRef( this.cache, nodeDef.extensions[ this.name ].light );

				}

			}

		}

		_loadLight( lightIndex ) {

			const parser = this.parser;
			const cacheKey = 'light:' + lightIndex;
			let dependency = parser.cache.get( cacheKey );
			if ( dependency ) return dependency;
			const json = parser.json;
			const extensions = json.extensions && json.extensions[ this.name ] || {};
			const lightDefs = extensions.lights || [];
			const lightDef = lightDefs[ lightIndex ];
			let lightNode;
			const color = new THREE.Color( 0xffffff );
			if ( lightDef.color !== undefined ) color.fromArray( lightDef.color );
			const range = lightDef.range !== undefined ? lightDef.range : 0;

			switch ( lightDef.type ) {

				case 'directional':
					lightNode = new THREE.DirectionalLight( color );
					lightNode.target.position.set( 0, 0, - 1 );
					lightNode.add( lightNode.target );
					break;

				case 'point':
					lightNode = new THREE.PointLight( color );
					lightNode.distance = range;
					break;

				case 'spot':
					lightNode = new THREE.SpotLight( color );
					lightNode.distance = range; // Handle spotlight properties.

					lightDef.spot = lightDef.spot || {};
					lightDef.spot.innerConeAngle = lightDef.spot.innerConeAngle !== undefined ? lightDef.spot.innerConeAngle : 0;
					lightDef.spot.outerConeAngle = lightDef.spot.outerConeAngle !== undefined ? lightDef.spot.outerConeAngle : Math.PI / 4.0;
					lightNode.angle = lightDef.spot.outerConeAngle;
					lightNode.penumbra = 1.0 - lightDef.spot.innerConeAngle / lightDef.spot.outerConeAngle;
					lightNode.target.position.set( 0, 0, - 1 );
					lightNode.add( lightNode.target );
					break;

				default:
					throw new Error( 'THREE.GLTFLoader: Unexpected light type: ' + lightDef.type );

			} // Some lights (e.g. spot) default to a position other than the origin. Reset the position
			// here, because node-level parsing will only override position if explicitly specified.


			lightNode.position.set( 0, 0, 0 );
			lightNode.decay = 2;
			if ( lightDef.intensity !== undefined ) lightNode.intensity = lightDef.intensity;
			lightNode.name = parser.createUniqueName( lightDef.name || 'light_' + lightIndex );
			dependency = Promise.resolve( lightNode );
			parser.cache.add( cacheKey, dependency );
			return dependency;

		}

		createNodeAttachment( nodeIndex ) {

			const self = this;
			const parser = this.parser;
			const json = parser.json;
			const nodeDef = json.nodes[ nodeIndex ];
			const lightDef = nodeDef.extensions && nodeDef.extensions[ this.name ] || {};
			const lightIndex = lightDef.light;
			if ( lightIndex === undefined ) return null;
			return this._loadLight( lightIndex ).then( function ( light ) {

				return parser._getNodeRef( self.cache, lightIndex, light );

			} );

		}

	}
	/**
	 * Unlit Materials Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_unlit
	 */


	class GLTFMaterialsUnlitExtension {

		constructor() {

			this.name = EXTENSIONS.KHR_MATERIALS_UNLIT;

		}

		getMaterialType() {

			return THREE.MeshBasicMaterial;

		}

		extendParams( materialParams, materialDef, parser ) {

			const pending = [];
			materialParams.color = new THREE.Color( 1.0, 1.0, 1.0 );
			materialParams.opacity = 1.0;
			const metallicRoughness = materialDef.pbrMetallicRoughness;

			if ( metallicRoughness ) {

				if ( Array.isArray( metallicRoughness.baseColorFactor ) ) {

					const array = metallicRoughness.baseColorFactor;
					materialParams.color.fromArray( array );
					materialParams.opacity = array[ 3 ];

				}

				if ( metallicRoughness.baseColorTexture !== undefined ) {

					pending.push( parser.assignTexture( materialParams, 'map', metallicRoughness.baseColorTexture ) );

				}

			}

			return Promise.all( pending );

		}

	}
	/**
	 * Clearcoat Materials Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_clearcoat
	 */


	class GLTFMaterialsClearcoatExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_CLEARCOAT;

		}

		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}

		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];

			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			const extension = materialDef.extensions[ this.name ];

			if ( extension.clearcoatFactor !== undefined ) {

				materialParams.clearcoat = extension.clearcoatFactor;

			}

			if ( extension.clearcoatTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'clearcoatMap', extension.clearcoatTexture ) );

			}

			if ( extension.clearcoatRoughnessFactor !== undefined ) {

				materialParams.clearcoatRoughness = extension.clearcoatRoughnessFactor;

			}

			if ( extension.clearcoatRoughnessTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'clearcoatRoughnessMap', extension.clearcoatRoughnessTexture ) );

			}

			if ( extension.clearcoatNormalTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'clearcoatNormalMap', extension.clearcoatNormalTexture ) );

				if ( extension.clearcoatNormalTexture.scale !== undefined ) {

					const scale = extension.clearcoatNormalTexture.scale; // https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995

					materialParams.clearcoatNormalScale = new THREE.Vector2( scale, - scale );

				}

			}

			return Promise.all( pending );

		}

	}
	/**
	 * Transmission Materials Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_transmission
	 * Draft: https://github.com/KhronosGroup/glTF/pull/1698
	 */


	class GLTFMaterialsTransmissionExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_TRANSMISSION;

		}

		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}

		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];

			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			const extension = materialDef.extensions[ this.name ];

			if ( extension.transmissionFactor !== undefined ) {

				materialParams.transmission = extension.transmissionFactor;

			}

			if ( extension.transmissionTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'transmissionMap', extension.transmissionTexture ) );

			}

			return Promise.all( pending );

		}

	}
	/**
	 * BasisU Texture Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_texture_basisu
	 */


	class GLTFTextureBasisUExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_TEXTURE_BASISU;

		}

		loadTexture( textureIndex ) {

			const parser = this.parser;
			const json = parser.json;
			const textureDef = json.textures[ textureIndex ];

			if ( ! textureDef.extensions || ! textureDef.extensions[ this.name ] ) {

				return null;

			}

			const extension = textureDef.extensions[ this.name ];
			const source = json.images[ extension.source ];
			const loader = parser.options.ktx2Loader;

			if ( ! loader ) {

				if ( json.extensionsRequired && json.extensionsRequired.indexOf( this.name ) >= 0 ) {

					throw new Error( 'THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures' );

				} else {

					// Assumes that the extension is optional and that a fallback texture is present
					return null;

				}

			}

			return parser.loadTextureImage( textureIndex, source, loader );

		}

	}
	/**
	 * WebP Texture Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Vendor/EXT_texture_webp
	 */


	class GLTFTextureWebPExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.EXT_TEXTURE_WEBP;
			this.isSupported = null;

		}

		loadTexture( textureIndex ) {

			const name = this.name;
			const parser = this.parser;
			const json = parser.json;
			const textureDef = json.textures[ textureIndex ];

			if ( ! textureDef.extensions || ! textureDef.extensions[ name ] ) {

				return null;

			}

			const extension = textureDef.extensions[ name ];
			const source = json.images[ extension.source ];
			let loader = parser.textureLoader;

			if ( source.uri ) {

				const handler = parser.options.manager.getHandler( source.uri );
				if ( handler !== null ) loader = handler;

			}

			return this.detectSupport().then( function ( isSupported ) {

				if ( isSupported ) return parser.loadTextureImage( textureIndex, source, loader );

				if ( json.extensionsRequired && json.extensionsRequired.indexOf( name ) >= 0 ) {

					throw new Error( 'THREE.GLTFLoader: WebP required by asset but unsupported.' );

				} // Fall back to PNG or JPEG.


				return parser.loadTexture( textureIndex );

			} );

		}

		detectSupport() {

			if ( ! this.isSupported ) {

				this.isSupported = new Promise( function ( resolve ) {

					const image = new Image(); // Lossy test image. Support for lossy images doesn't guarantee support for all
					// WebP images, unfortunately.

					image.src = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';

					image.onload = image.onerror = function () {

						resolve( image.height === 1 );

					};

				} );

			}

			return this.isSupported;

		}

	}
	/**
	* meshopt BufferView Compression Extension
	*
	* Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Vendor/EXT_meshopt_compression
	*/


	class GLTFMeshoptCompression {

		constructor( parser ) {

			this.name = EXTENSIONS.EXT_MESHOPT_COMPRESSION;
			this.parser = parser;

		}

		loadBufferView( index ) {

			const json = this.parser.json;
			const bufferView = json.bufferViews[ index ];

			if ( bufferView.extensions && bufferView.extensions[ this.name ] ) {

				const extensionDef = bufferView.extensions[ this.name ];
				const buffer = this.parser.getDependency( 'buffer', extensionDef.buffer );
				const decoder = this.parser.options.meshoptDecoder;

				if ( ! decoder || ! decoder.supported ) {

					if ( json.extensionsRequired && json.extensionsRequired.indexOf( this.name ) >= 0 ) {

						throw new Error( 'THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files' );

					} else {

						// Assumes that the extension is optional and that fallback buffer data is present
						return null;

					}

				}

				return Promise.all( [ buffer, decoder.ready ] ).then( function ( res ) {

					const byteOffset = extensionDef.byteOffset || 0;
					const byteLength = extensionDef.byteLength || 0;
					const count = extensionDef.count;
					const stride = extensionDef.byteStride;
					const result = new ArrayBuffer( count * stride );
					const source = new Uint8Array( res[ 0 ], byteOffset, byteLength );
					decoder.decodeGltfBuffer( new Uint8Array( result ), count, stride, source, extensionDef.mode, extensionDef.filter );
					return result;

				} );

			} else {

				return null;

			}

		}

	}
	/* BINARY EXTENSION */


	const BINARY_EXTENSION_HEADER_MAGIC = 'glTF';
	const BINARY_EXTENSION_HEADER_LENGTH = 12;
	const BINARY_EXTENSION_CHUNK_TYPES = {
		JSON: 0x4E4F534A,
		BIN: 0x004E4942
	};

	class GLTFBinaryExtension {

		constructor( data ) {

			this.name = EXTENSIONS.KHR_BINARY_GLTF;
			this.content = null;
			this.body = null;
			const headerView = new DataView( data, 0, BINARY_EXTENSION_HEADER_LENGTH );
			this.header = {
				magic: THREE.LoaderUtils.decodeText( new Uint8Array( data.slice( 0, 4 ) ) ),
				version: headerView.getUint32( 4, true ),
				length: headerView.getUint32( 8, true )
			};

			if ( this.header.magic !== BINARY_EXTENSION_HEADER_MAGIC ) {

				throw new Error( 'THREE.GLTFLoader: Unsupported glTF-Binary header.' );

			} else if ( this.header.version < 2.0 ) {

				throw new Error( 'THREE.GLTFLoader: Legacy binary file detected.' );

			}

			const chunkContentsLength = this.header.length - BINARY_EXTENSION_HEADER_LENGTH;
			const chunkView = new DataView( data, BINARY_EXTENSION_HEADER_LENGTH );
			let chunkIndex = 0;

			while ( chunkIndex < chunkContentsLength ) {

				const chunkLength = chunkView.getUint32( chunkIndex, true );
				chunkIndex += 4;
				const chunkType = chunkView.getUint32( chunkIndex, true );
				chunkIndex += 4;

				if ( chunkType === BINARY_EXTENSION_CHUNK_TYPES.JSON ) {

					const contentArray = new Uint8Array( data, BINARY_EXTENSION_HEADER_LENGTH + chunkIndex, chunkLength );
					this.content = THREE.LoaderUtils.decodeText( contentArray );

				} else if ( chunkType === BINARY_EXTENSION_CHUNK_TYPES.BIN ) {

					const byteOffset = BINARY_EXTENSION_HEADER_LENGTH + chunkIndex;
					this.body = data.slice( byteOffset, byteOffset + chunkLength );

				} // Clients must ignore chunks with unknown types.


				chunkIndex += chunkLength;

			}

			if ( this.content === null ) {

				throw new Error( 'THREE.GLTFLoader: JSON content not found.' );

			}

		}

	}
	/**
	 * DRACO THREE.Mesh Compression Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_draco_mesh_compression
	 */


	class GLTFDracoMeshCompressionExtension {

		constructor( json, dracoLoader ) {

			if ( ! dracoLoader ) {

				throw new Error( 'THREE.GLTFLoader: No DRACOLoader instance provided.' );

			}

			this.name = EXTENSIONS.KHR_DRACO_MESH_COMPRESSION;
			this.json = json;
			this.dracoLoader = dracoLoader;
			this.dracoLoader.preload();

		}

		decodePrimitive( primitive, parser ) {

			const json = this.json;
			const dracoLoader = this.dracoLoader;
			const bufferViewIndex = primitive.extensions[ this.name ].bufferView;
			const gltfAttributeMap = primitive.extensions[ this.name ].attributes;
			const threeAttributeMap = {};
			const attributeNormalizedMap = {};
			const attributeTypeMap = {};

			for ( const attributeName in gltfAttributeMap ) {

				const threeAttributeName = ATTRIBUTES[ attributeName ] || attributeName.toLowerCase();
				threeAttributeMap[ threeAttributeName ] = gltfAttributeMap[ attributeName ];

			}

			for ( const attributeName in primitive.attributes ) {

				const threeAttributeName = ATTRIBUTES[ attributeName ] || attributeName.toLowerCase();

				if ( gltfAttributeMap[ attributeName ] !== undefined ) {

					const accessorDef = json.accessors[ primitive.attributes[ attributeName ] ];
					const componentType = WEBGL_COMPONENT_TYPES[ accessorDef.componentType ];
					attributeTypeMap[ threeAttributeName ] = componentType;
					attributeNormalizedMap[ threeAttributeName ] = accessorDef.normalized === true;

				}

			}

			return parser.getDependency( 'bufferView', bufferViewIndex ).then( function ( bufferView ) {

				return new Promise( function ( resolve ) {

					dracoLoader.decodeDracoFile( bufferView, function ( geometry ) {

						for ( const attributeName in geometry.attributes ) {

							const attribute = geometry.attributes[ attributeName ];
							const normalized = attributeNormalizedMap[ attributeName ];
							if ( normalized !== undefined ) attribute.normalized = normalized;

						}

						resolve( geometry );

					}, threeAttributeMap, attributeTypeMap );

				} );

			} );

		}

	}
	/**
	 * Texture Transform Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_texture_transform
	 */


	class GLTFTextureTransformExtension {

		constructor() {

			this.name = EXTENSIONS.KHR_TEXTURE_TRANSFORM;

		}

		extendTexture( texture, transform ) {

			texture = texture.clone();

			if ( transform.offset !== undefined ) {

				texture.offset.fromArray( transform.offset );

			}

			if ( transform.rotation !== undefined ) {

				texture.rotation = transform.rotation;

			}

			if ( transform.scale !== undefined ) {

				texture.repeat.fromArray( transform.scale );

			}

			if ( transform.texCoord !== undefined ) {

				console.warn( 'THREE.GLTFLoader: Custom UV sets in "' + this.name + '" extension not yet supported.' );

			}

			texture.needsUpdate = true;
			return texture;

		}

	}
	/**
	 * Specular-Glossiness Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_pbrSpecularGlossiness
	 */

	/**
	 * A sub class of StandardMaterial with some of the functionality
	 * changed via the `onBeforeCompile` callback
	 * @pailhead
	 */


	class GLTFMeshStandardSGMaterial extends THREE.MeshStandardMaterial {

		constructor( params ) {

			super();
			this.isGLTFSpecularGlossinessMaterial = true; //various chunks that need replacing

			const specularMapParsFragmentChunk = [ '#ifdef USE_SPECULARMAP', '	uniform sampler2D specularMap;', '#endif' ].join( '\n' );
			const glossinessMapParsFragmentChunk = [ '#ifdef USE_GLOSSINESSMAP', '	uniform sampler2D glossinessMap;', '#endif' ].join( '\n' );
			const specularMapFragmentChunk = [ 'vec3 specularFactor = specular;', '#ifdef USE_SPECULARMAP', '	vec4 texelSpecular = texture2D( specularMap, vUv );', '	texelSpecular = sRGBToLinear( texelSpecular );', '	// reads channel RGB, compatible with a glTF Specular-Glossiness (RGBA) texture', '	specularFactor *= texelSpecular.rgb;', '#endif' ].join( '\n' );
			const glossinessMapFragmentChunk = [ 'float glossinessFactor = glossiness;', '#ifdef USE_GLOSSINESSMAP', '	vec4 texelGlossiness = texture2D( glossinessMap, vUv );', '	// reads channel A, compatible with a glTF Specular-Glossiness (RGBA) texture', '	glossinessFactor *= texelGlossiness.a;', '#endif' ].join( '\n' );
			const lightPhysicalFragmentChunk = [ 'PhysicalMaterial material;', 'material.diffuseColor = diffuseColor.rgb * ( 1. - max( specularFactor.r, max( specularFactor.g, specularFactor.b ) ) );', 'vec3 dxy = max( abs( dFdx( geometryNormal ) ), abs( dFdy( geometryNormal ) ) );', 'float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );', 'material.specularRoughness = max( 1.0 - glossinessFactor, 0.0525 ); // 0.0525 corresponds to the base mip of a 256 cubemap.', 'material.specularRoughness += geometryRoughness;', 'material.specularRoughness = min( material.specularRoughness, 1.0 );', 'material.specularColor = specularFactor;' ].join( '\n' );
			const uniforms = {
				specular: {
					value: new THREE.Color().setHex( 0xffffff )
				},
				glossiness: {
					value: 1
				},
				specularMap: {
					value: null
				},
				glossinessMap: {
					value: null
				}
			};
			this._extraUniforms = uniforms;

			this.onBeforeCompile = function ( shader ) {

				for ( const uniformName in uniforms ) {

					shader.uniforms[ uniformName ] = uniforms[ uniformName ];

				}

				shader.fragmentShader = shader.fragmentShader.replace( 'uniform float roughness;', 'uniform vec3 specular;' ).replace( 'uniform float metalness;', 'uniform float glossiness;' ).replace( '#include <roughnessmap_pars_fragment>', specularMapParsFragmentChunk ).replace( '#include <metalnessmap_pars_fragment>', glossinessMapParsFragmentChunk ).replace( '#include <roughnessmap_fragment>', specularMapFragmentChunk ).replace( '#include <metalnessmap_fragment>', glossinessMapFragmentChunk ).replace( '#include <lights_physical_fragment>', lightPhysicalFragmentChunk );

			};

			Object.defineProperties( this, {
				specular: {
					get: function () {

						return uniforms.specular.value;

					},
					set: function ( v ) {

						uniforms.specular.value = v;

					}
				},
				specularMap: {
					get: function () {

						return uniforms.specularMap.value;

					},
					set: function ( v ) {

						uniforms.specularMap.value = v;

						if ( v ) {

							this.defines.USE_SPECULARMAP = ''; // USE_UV is set by the renderer for specular maps

						} else {

							delete this.defines.USE_SPECULARMAP;

						}

					}
				},
				glossiness: {
					get: function () {

						return uniforms.glossiness.value;

					},
					set: function ( v ) {

						uniforms.glossiness.value = v;

					}
				},
				glossinessMap: {
					get: function () {

						return uniforms.glossinessMap.value;

					},
					set: function ( v ) {

						uniforms.glossinessMap.value = v;

						if ( v ) {

							this.defines.USE_GLOSSINESSMAP = '';
							this.defines.USE_UV = '';

						} else {

							delete this.defines.USE_GLOSSINESSMAP;
							delete this.defines.USE_UV;

						}

					}
				}
			} );
			delete this.metalness;
			delete this.roughness;
			delete this.metalnessMap;
			delete this.roughnessMap;
			this.setValues( params );

		}

		copy( source ) {

			super.copy( source );
			this.specularMap = source.specularMap;
			this.specular.copy( source.specular );
			this.glossinessMap = source.glossinessMap;
			this.glossiness = source.glossiness;
			delete this.metalness;
			delete this.roughness;
			delete this.metalnessMap;
			delete this.roughnessMap;
			return this;

		}

	}

	class GLTFMaterialsPbrSpecularGlossinessExtension {

		constructor() {

			this.name = EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS;
			this.specularGlossinessParams = [ 'color', 'map', 'lightMap', 'lightMapIntensity', 'aoMap', 'aoMapIntensity', 'emissive', 'emissiveIntensity', 'emissiveMap', 'bumpMap', 'bumpScale', 'normalMap', 'normalMapType', 'displacementMap', 'displacementScale', 'displacementBias', 'specularMap', 'specular', 'glossinessMap', 'glossiness', 'alphaMap', 'envMap', 'envMapIntensity', 'refractionRatio' ];

		}

		getMaterialType() {

			return GLTFMeshStandardSGMaterial;

		}

		extendParams( materialParams, materialDef, parser ) {

			const pbrSpecularGlossiness = materialDef.extensions[ this.name ];
			materialParams.color = new THREE.Color( 1.0, 1.0, 1.0 );
			materialParams.opacity = 1.0;
			const pending = [];

			if ( Array.isArray( pbrSpecularGlossiness.diffuseFactor ) ) {

				const array = pbrSpecularGlossiness.diffuseFactor;
				materialParams.color.fromArray( array );
				materialParams.opacity = array[ 3 ];

			}

			if ( pbrSpecularGlossiness.diffuseTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'map', pbrSpecularGlossiness.diffuseTexture ) );

			}

			materialParams.emissive = new THREE.Color( 0.0, 0.0, 0.0 );
			materialParams.glossiness = pbrSpecularGlossiness.glossinessFactor !== undefined ? pbrSpecularGlossiness.glossinessFactor : 1.0;
			materialParams.specular = new THREE.Color( 1.0, 1.0, 1.0 );

			if ( Array.isArray( pbrSpecularGlossiness.specularFactor ) ) {

				materialParams.specular.fromArray( pbrSpecularGlossiness.specularFactor );

			}

			if ( pbrSpecularGlossiness.specularGlossinessTexture !== undefined ) {

				const specGlossMapDef = pbrSpecularGlossiness.specularGlossinessTexture;
				pending.push( parser.assignTexture( materialParams, 'glossinessMap', specGlossMapDef ) );
				pending.push( parser.assignTexture( materialParams, 'specularMap', specGlossMapDef ) );

			}

			return Promise.all( pending );

		}

		createMaterial( materialParams ) {

			const material = new GLTFMeshStandardSGMaterial( materialParams );
			material.fog = true;
			material.color = materialParams.color;
			material.map = materialParams.map === undefined ? null : materialParams.map;
			material.lightMap = null;
			material.lightMapIntensity = 1.0;
			material.aoMap = materialParams.aoMap === undefined ? null : materialParams.aoMap;
			material.aoMapIntensity = 1.0;
			material.emissive = materialParams.emissive;
			material.emissiveIntensity = 1.0;
			material.emissiveMap = materialParams.emissiveMap === undefined ? null : materialParams.emissiveMap;
			material.bumpMap = materialParams.bumpMap === undefined ? null : materialParams.bumpMap;
			material.bumpScale = 1;
			material.normalMap = materialParams.normalMap === undefined ? null : materialParams.normalMap;
			material.normalMapType = THREE.TangentSpaceNormalMap;
			if ( materialParams.normalScale ) material.normalScale = materialParams.normalScale;
			material.displacementMap = null;
			material.displacementScale = 1;
			material.displacementBias = 0;
			material.specularMap = materialParams.specularMap === undefined ? null : materialParams.specularMap;
			material.specular = materialParams.specular;
			material.glossinessMap = materialParams.glossinessMap === undefined ? null : materialParams.glossinessMap;
			material.glossiness = materialParams.glossiness;
			material.alphaMap = null;
			material.envMap = materialParams.envMap === undefined ? null : materialParams.envMap;
			material.envMapIntensity = 1.0;
			material.refractionRatio = 0.98;
			return material;

		}

	}
	/**
	 * THREE.Mesh Quantization Extension
	 *
	 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization
	 */


	class GLTFMeshQuantizationExtension {

		constructor() {

			this.name = EXTENSIONS.KHR_MESH_QUANTIZATION;

		}

	}
	/*********************************/

	/********** INTERPOLATION ********/

	/*********************************/
	// Spline Interpolation
	// Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#appendix-c-spline-interpolation


	class GLTFCubicSplineInterpolant extends THREE.Interpolant {

		constructor( parameterPositions, sampleValues, sampleSize, resultBuffer ) {

			super( parameterPositions, sampleValues, sampleSize, resultBuffer );

		}

		copySampleValue_( index ) {

			// Copies a sample value to the result buffer. See description of glTF
			// CUBICSPLINE values layout in interpolate_() function below.
			const result = this.resultBuffer,
				values = this.sampleValues,
				valueSize = this.valueSize,
				offset = index * valueSize * 3 + valueSize;

			for ( let i = 0; i !== valueSize; i ++ ) {

				result[ i ] = values[ offset + i ];

			}

			return result;

		}

	}

	GLTFCubicSplineInterpolant.prototype.beforeStart_ = GLTFCubicSplineInterpolant.prototype.copySampleValue_;
	GLTFCubicSplineInterpolant.prototype.afterEnd_ = GLTFCubicSplineInterpolant.prototype.copySampleValue_;

	GLTFCubicSplineInterpolant.prototype.interpolate_ = function ( i1, t0, t, t1 ) {

		const result = this.resultBuffer;
		const values = this.sampleValues;
		const stride = this.valueSize;
		const stride2 = stride * 2;
		const stride3 = stride * 3;
		const td = t1 - t0;
		const p = ( t - t0 ) / td;
		const pp = p * p;
		const ppp = pp * p;
		const offset1 = i1 * stride3;
		const offset0 = offset1 - stride3;
		const s2 = - 2 * ppp + 3 * pp;
		const s3 = ppp - pp;
		const s0 = 1 - s2;
		const s1 = s3 - pp + p; // Layout of keyframe output values for CUBICSPLINE animations:
		//   [ inTangent_1, splineVertex_1, outTangent_1, inTangent_2, splineVertex_2, ... ]

		for ( let i = 0; i !== stride; i ++ ) {

			const p0 = values[ offset0 + i + stride ]; // splineVertex_k

			const m0 = values[ offset0 + i + stride2 ] * td; // outTangent_k * (t_k+1 - t_k)

			const p1 = values[ offset1 + i + stride ]; // splineVertex_k+1

			const m1 = values[ offset1 + i ] * td; // inTangent_k+1 * (t_k+1 - t_k)

			result[ i ] = s0 * p0 + s1 * m0 + s2 * p1 + s3 * m1;

		}

		return result;

	};
	/*********************************/

	/********** INTERNALS ************/

	/*********************************/

	/* CONSTANTS */


	const WEBGL_CONSTANTS = {
		FLOAT: 5126,
		//FLOAT_MAT2: 35674,
		FLOAT_MAT3: 35675,
		FLOAT_MAT4: 35676,
		FLOAT_VEC2: 35664,
		FLOAT_VEC3: 35665,
		FLOAT_VEC4: 35666,
		LINEAR: 9729,
		REPEAT: 10497,
		SAMPLER_2D: 35678,
		POINTS: 0,
		LINES: 1,
		LINE_LOOP: 2,
		LINE_STRIP: 3,
		TRIANGLES: 4,
		TRIANGLE_STRIP: 5,
		TRIANGLE_FAN: 6,
		UNSIGNED_BYTE: 5121,
		UNSIGNED_SHORT: 5123
	};
	const WEBGL_COMPONENT_TYPES = {
		5120: Int8Array,
		5121: Uint8Array,
		5122: Int16Array,
		5123: Uint16Array,
		5125: Uint32Array,
		5126: Float32Array
	};
	const WEBGL_FILTERS = {
		9728: THREE.NearestFilter,
		9729: THREE.LinearFilter,
		9984: THREE.NearestMipmapNearestFilter,
		9985: THREE.LinearMipmapNearestFilter,
		9986: THREE.NearestMipmapLinearFilter,
		9987: THREE.LinearMipmapLinearFilter
	};
	const WEBGL_WRAPPINGS = {
		33071: THREE.ClampToEdgeWrapping,
		33648: THREE.MirroredRepeatWrapping,
		10497: THREE.RepeatWrapping
	};
	const WEBGL_TYPE_SIZES = {
		'SCALAR': 1,
		'VEC2': 2,
		'VEC3': 3,
		'VEC4': 4,
		'MAT2': 4,
		'MAT3': 9,
		'MAT4': 16
	};
	const ATTRIBUTES = {
		POSITION: 'position',
		NORMAL: 'normal',
		TANGENT: 'tangent',
		TEXCOORD_0: 'uv',
		TEXCOORD_1: 'uv2',
		COLOR_0: 'color',
		WEIGHTS_0: 'skinWeight',
		JOINTS_0: 'skinIndex'
	};
	const PATH_PROPERTIES = {
		scale: 'scale',
		translation: 'position',
		rotation: 'quaternion',
		weights: 'morphTargetInfluences'
	};
	const INTERPOLATION = {
		CUBICSPLINE: undefined,
		// We use a custom interpolant (GLTFCubicSplineInterpolation) for CUBICSPLINE tracks. Each
		// keyframe track will be initialized with a default interpolation type, then modified.
		LINEAR: THREE.InterpolateLinear,
		STEP: THREE.InterpolateDiscrete
	};
	const ALPHA_MODES = {
		OPAQUE: 'OPAQUE',
		MASK: 'MASK',
		BLEND: 'BLEND'
	};
	/* UTILITY FUNCTIONS */

	function resolveURL( url, path ) {

		// Invalid URL
		if ( typeof url !== 'string' || url === '' ) return ''; // Host Relative URL

		if ( /^https?:\/\//i.test( path ) && /^\//.test( url ) ) {

			path = path.replace( /(^https?:\/\/[^\/]+).*/i, '$1' );

		} // Absolute URL http://,https://,//


		if ( /^(https?:)?\/\//i.test( url ) ) return url; // Data URI

		if ( /^data:.*,.*$/i.test( url ) ) return url; // Blob URL

		if ( /^blob:.*$/i.test( url ) ) return url; // Relative URL

		return path + url;

	}
	/**
	 * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#default-material
	 */


	function createDefaultMaterial( cache ) {

		if ( cache[ 'DefaultMaterial' ] === undefined ) {

			cache[ 'DefaultMaterial' ] = new THREE.MeshStandardMaterial( {
				color: 0xFFFFFF,
				emissive: 0x000000,
				metalness: 1,
				roughness: 1,
				transparent: false,
				depthTest: true,
				side: THREE.FrontSide
			} );

		}

		return cache[ 'DefaultMaterial' ];

	}

	function addUnknownExtensionsToUserData( knownExtensions, object, objectDef ) {

		// Add unknown glTF extensions to an object's userData.
		for ( const name in objectDef.extensions ) {

			if ( knownExtensions[ name ] === undefined ) {

				object.userData.gltfExtensions = object.userData.gltfExtensions || {};
				object.userData.gltfExtensions[ name ] = objectDef.extensions[ name ];

			}

		}

	}
	/**
	 * @param {Object3D|Material|BufferGeometry} object
	 * @param {GLTF.definition} gltfDef
	 */


	function assignExtrasToUserData( object, gltfDef ) {

		if ( gltfDef.extras !== undefined ) {

			if ( typeof gltfDef.extras === 'object' ) {

				Object.assign( object.userData, gltfDef.extras );

			} else {

				console.warn( 'THREE.GLTFLoader: Ignoring primitive type .extras, ' + gltfDef.extras );

			}

		}

	}
	/**
	 * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#morph-targets
	 *
	 * @param {BufferGeometry} geometry
	 * @param {Array<GLTF.Target>} targets
	 * @param {GLTFParser} parser
	 * @return {Promise<BufferGeometry>}
	 */


	function addMorphTargets( geometry, targets, parser ) {

		let hasMorphPosition = false;
		let hasMorphNormal = false;

		for ( let i = 0, il = targets.length; i < il; i ++ ) {

			const target = targets[ i ];
			if ( target.POSITION !== undefined ) hasMorphPosition = true;
			if ( target.NORMAL !== undefined ) hasMorphNormal = true;
			if ( hasMorphPosition && hasMorphNormal ) break;

		}

		if ( ! hasMorphPosition && ! hasMorphNormal ) return Promise.resolve( geometry );
		const pendingPositionAccessors = [];
		const pendingNormalAccessors = [];

		for ( let i = 0, il = targets.length; i < il; i ++ ) {

			const target = targets[ i ];

			if ( hasMorphPosition ) {

				const pendingAccessor = target.POSITION !== undefined ? parser.getDependency( 'accessor', target.POSITION ) : geometry.attributes.position;
				pendingPositionAccessors.push( pendingAccessor );

			}

			if ( hasMorphNormal ) {

				const pendingAccessor = target.NORMAL !== undefined ? parser.getDependency( 'accessor', target.NORMAL ) : geometry.attributes.normal;
				pendingNormalAccessors.push( pendingAccessor );

			}

		}

		return Promise.all( [ Promise.all( pendingPositionAccessors ), Promise.all( pendingNormalAccessors ) ] ).then( function ( accessors ) {

			const morphPositions = accessors[ 0 ];
			const morphNormals = accessors[ 1 ];
			if ( hasMorphPosition ) geometry.morphAttributes.position = morphPositions;
			if ( hasMorphNormal ) geometry.morphAttributes.normal = morphNormals;
			geometry.morphTargetsRelative = true;
			return geometry;

		} );

	}
	/**
	 * @param {Mesh} mesh
	 * @param {GLTF.Mesh} meshDef
	 */


	function updateMorphTargets( mesh, meshDef ) {

		mesh.updateMorphTargets();

		if ( meshDef.weights !== undefined ) {

			for ( let i = 0, il = meshDef.weights.length; i < il; i ++ ) {

				mesh.morphTargetInfluences[ i ] = meshDef.weights[ i ];

			}

		} // .extras has user-defined data, so check that .extras.targetNames is an array.


		if ( meshDef.extras && Array.isArray( meshDef.extras.targetNames ) ) {

			const targetNames = meshDef.extras.targetNames;

			if ( mesh.morphTargetInfluences.length === targetNames.length ) {

				mesh.morphTargetDictionary = {};

				for ( let i = 0, il = targetNames.length; i < il; i ++ ) {

					mesh.morphTargetDictionary[ targetNames[ i ] ] = i;

				}

			} else {

				console.warn( 'THREE.GLTFLoader: Invalid extras.targetNames length. Ignoring names.' );

			}

		}

	}

	function createPrimitiveKey( primitiveDef ) {

		const dracoExtension = primitiveDef.extensions && primitiveDef.extensions[ EXTENSIONS.KHR_DRACO_MESH_COMPRESSION ];
		let geometryKey;

		if ( dracoExtension ) {

			geometryKey = 'draco:' + dracoExtension.bufferView + ':' + dracoExtension.indices + ':' + createAttributesKey( dracoExtension.attributes );

		} else {

			geometryKey = primitiveDef.indices + ':' + createAttributesKey( primitiveDef.attributes ) + ':' + primitiveDef.mode;

		}

		return geometryKey;

	}

	function createAttributesKey( attributes ) {

		let attributesKey = '';
		const keys = Object.keys( attributes ).sort();

		for ( let i = 0, il = keys.length; i < il; i ++ ) {

			attributesKey += keys[ i ] + ':' + attributes[ keys[ i ] ] + ';';

		}

		return attributesKey;

	}

	function getNormalizedComponentScale( constructor ) {

		// Reference:
		// https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization#encoding-quantized-data
		switch ( constructor ) {

			case Int8Array:
				return 1 / 127;

			case Uint8Array:
				return 1 / 255;

			case Int16Array:
				return 1 / 32767;

			case Uint16Array:
				return 1 / 65535;

			default:
				throw new Error( 'THREE.GLTFLoader: Unsupported normalized accessor component type.' );

		}

	}
	/* GLTF PARSER */


	class GLTFParser {

		constructor( json = {}, options = {} ) {

			this.json = json;
			this.extensions = {};
			this.plugins = {};
			this.options = options; // loader object cache

			this.cache = new GLTFRegistry(); // associations between Three.js objects and glTF elements

			this.associations = new Map(); // THREE.BufferGeometry caching

			this.primitiveCache = {}; // THREE.Object3D instance caches

			this.meshCache = {
				refs: {},
				uses: {}
			};
			this.cameraCache = {
				refs: {},
				uses: {}
			};
			this.lightCache = {
				refs: {},
				uses: {}
			}; // Track node names, to ensure no duplicates

			this.nodeNamesUsed = {}; // Use an THREE.ImageBitmapLoader if imageBitmaps are supported. Moves much of the
			// expensive work of uploading a texture to the GPU off the main thread.

			if ( typeof createImageBitmap !== 'undefined' && /Firefox/.test( navigator.userAgent ) === false ) {

				this.textureLoader = new THREE.ImageBitmapLoader( this.options.manager );

			} else {

				this.textureLoader = new THREE.TextureLoader( this.options.manager );

			}

			this.textureLoader.setCrossOrigin( this.options.crossOrigin );
			this.textureLoader.setRequestHeader( this.options.requestHeader );
			this.fileLoader = new THREE.FileLoader( this.options.manager );
			this.fileLoader.setResponseType( 'arraybuffer' );

			if ( this.options.crossOrigin === 'use-credentials' ) {

				this.fileLoader.setWithCredentials( true );

			}

		}

		setExtensions( extensions ) {

			this.extensions = extensions;

		}

		setPlugins( plugins ) {

			this.plugins = plugins;

		}

		parse( onLoad, onError ) {

			const parser = this;
			const json = this.json;
			const extensions = this.extensions; // Clear the loader cache

			this.cache.removeAll(); // Mark the special nodes/meshes in json for efficient parse

			this._invokeAll( function ( ext ) {

				return ext._markDefs && ext._markDefs();

			} );

			Promise.all( this._invokeAll( function ( ext ) {

				return ext.beforeRoot && ext.beforeRoot();

			} ) ).then( function () {

				return Promise.all( [ parser.getDependencies( 'scene' ), parser.getDependencies( 'animation' ), parser.getDependencies( 'camera' ) ] );

			} ).then( function ( dependencies ) {

				const result = {
					scene: dependencies[ 0 ][ json.scene || 0 ],
					scenes: dependencies[ 0 ],
					animations: dependencies[ 1 ],
					cameras: dependencies[ 2 ],
					asset: json.asset,
					parser: parser,
					userData: {}
				};
				addUnknownExtensionsToUserData( extensions, result, json );
				assignExtrasToUserData( result, json );
				Promise.all( parser._invokeAll( function ( ext ) {

					return ext.afterRoot && ext.afterRoot( result );

				} ) ).then( function () {

					onLoad( result );

				} );

			} ).catch( onError );

		}
		/**
   * Marks the special nodes/meshes in json for efficient parse.
   */


		_markDefs() {

			const nodeDefs = this.json.nodes || [];
			const skinDefs = this.json.skins || [];
			const meshDefs = this.json.meshes || []; // Nothing in the node definition indicates whether it is a THREE.Bone or an
			// THREE.Object3D. Use the skins' joint references to mark bones.

			for ( let skinIndex = 0, skinLength = skinDefs.length; skinIndex < skinLength; skinIndex ++ ) {

				const joints = skinDefs[ skinIndex ].joints;

				for ( let i = 0, il = joints.length; i < il; i ++ ) {

					nodeDefs[ joints[ i ] ].isBone = true;

				}

			} // Iterate over all nodes, marking references to shared resources,
			// as well as skeleton joints.


			for ( let nodeIndex = 0, nodeLength = nodeDefs.length; nodeIndex < nodeLength; nodeIndex ++ ) {

				const nodeDef = nodeDefs[ nodeIndex ];

				if ( nodeDef.mesh !== undefined ) {

					this._addNodeRef( this.meshCache, nodeDef.mesh ); // Nothing in the mesh definition indicates whether it is
					// a THREE.SkinnedMesh or THREE.Mesh. Use the node's mesh reference
					// to mark THREE.SkinnedMesh if node has skin.


					if ( nodeDef.skin !== undefined ) {

						meshDefs[ nodeDef.mesh ].isSkinnedMesh = true;

					}

				}

				if ( nodeDef.camera !== undefined ) {

					this._addNodeRef( this.cameraCache, nodeDef.camera );

				}

			}

		}
		/**
   * Counts references to shared node / THREE.Object3D resources. These resources
   * can be reused, or "instantiated", at multiple nodes in the scene
   * hierarchy. THREE.Mesh, Camera, and Light instances are instantiated and must
   * be marked. Non-scenegraph resources (like Materials, Geometries, and
   * Textures) can be reused directly and are not marked here.
   *
   * Example: CesiumMilkTruck sample model reuses "Wheel" meshes.
   */


		_addNodeRef( cache, index ) {

			if ( index === undefined ) return;

			if ( cache.refs[ index ] === undefined ) {

				cache.refs[ index ] = cache.uses[ index ] = 0;

			}

			cache.refs[ index ] ++;

		}
		/** Returns a reference to a shared resource, cloning it if necessary. */


		_getNodeRef( cache, index, object ) {

			if ( cache.refs[ index ] <= 1 ) return object;
			const ref = object.clone();
			ref.name += '_instance_' + cache.uses[ index ] ++;
			return ref;

		}

		_invokeOne( func ) {

			const extensions = Object.values( this.plugins );
			extensions.push( this );

			for ( let i = 0; i < extensions.length; i ++ ) {

				const result = func( extensions[ i ] );
				if ( result ) return result;

			}

			return null;

		}

		_invokeAll( func ) {

			const extensions = Object.values( this.plugins );
			extensions.unshift( this );
			const pending = [];

			for ( let i = 0; i < extensions.length; i ++ ) {

				const result = func( extensions[ i ] );
				if ( result ) pending.push( result );

			}

			return pending;

		}
		/**
   * Requests the specified dependency asynchronously, with caching.
   * @param {string} type
   * @param {number} index
   * @return {Promise<Object3D|Material|THREE.Texture|AnimationClip|ArrayBuffer|Object>}
   */


		getDependency( type, index ) {

			const cacheKey = type + ':' + index;
			let dependency = this.cache.get( cacheKey );

			if ( ! dependency ) {

				switch ( type ) {

					case 'scene':
						dependency = this.loadScene( index );
						break;

					case 'node':
						dependency = this.loadNode( index );
						break;

					case 'mesh':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadMesh && ext.loadMesh( index );

						} );
						break;

					case 'accessor':
						dependency = this.loadAccessor( index );
						break;

					case 'bufferView':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadBufferView && ext.loadBufferView( index );

						} );
						break;

					case 'buffer':
						dependency = this.loadBuffer( index );
						break;

					case 'material':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadMaterial && ext.loadMaterial( index );

						} );
						break;

					case 'texture':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadTexture && ext.loadTexture( index );

						} );
						break;

					case 'skin':
						dependency = this.loadSkin( index );
						break;

					case 'animation':
						dependency = this.loadAnimation( index );
						break;

					case 'camera':
						dependency = this.loadCamera( index );
						break;

					default:
						throw new Error( 'Unknown type: ' + type );

				}

				this.cache.add( cacheKey, dependency );

			}

			return dependency;

		}
		/**
   * Requests all dependencies of the specified type asynchronously, with caching.
   * @param {string} type
   * @return {Promise<Array<Object>>}
   */


		getDependencies( type ) {

			let dependencies = this.cache.get( type );

			if ( ! dependencies ) {

				const parser = this;
				const defs = this.json[ type + ( type === 'mesh' ? 'es' : 's' ) ] || [];
				dependencies = Promise.all( defs.map( function ( def, index ) {

					return parser.getDependency( type, index );

				} ) );
				this.cache.add( type, dependencies );

			}

			return dependencies;

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferIndex
   * @return {Promise<ArrayBuffer>}
   */


		loadBuffer( bufferIndex ) {

			const bufferDef = this.json.buffers[ bufferIndex ];
			const loader = this.fileLoader;

			if ( bufferDef.type && bufferDef.type !== 'arraybuffer' ) {

				throw new Error( 'THREE.GLTFLoader: ' + bufferDef.type + ' buffer type is not supported.' );

			} // If present, GLB container is required to be the first buffer.


			if ( bufferDef.uri === undefined && bufferIndex === 0 ) {

				return Promise.resolve( this.extensions[ EXTENSIONS.KHR_BINARY_GLTF ].body );

			}

			const options = this.options;
			return new Promise( function ( resolve, reject ) {

				loader.load( resolveURL( bufferDef.uri, options.path ), resolve, undefined, function () {

					reject( new Error( 'THREE.GLTFLoader: Failed to load buffer "' + bufferDef.uri + '".' ) );

				} );

			} );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferViewIndex
   * @return {Promise<ArrayBuffer>}
   */


		loadBufferView( bufferViewIndex ) {

			const bufferViewDef = this.json.bufferViews[ bufferViewIndex ];
			return this.getDependency( 'buffer', bufferViewDef.buffer ).then( function ( buffer ) {

				const byteLength = bufferViewDef.byteLength || 0;
				const byteOffset = bufferViewDef.byteOffset || 0;
				return buffer.slice( byteOffset, byteOffset + byteLength );

			} );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#accessors
   * @param {number} accessorIndex
   * @return {Promise<BufferAttribute|InterleavedBufferAttribute>}
   */


		loadAccessor( accessorIndex ) {

			const parser = this;
			const json = this.json;
			const accessorDef = this.json.accessors[ accessorIndex ];

			if ( accessorDef.bufferView === undefined && accessorDef.sparse === undefined ) {

				// Ignore empty accessors, which may be used to declare runtime
				// information about attributes coming from another source (e.g. Draco
				// compression extension).
				return Promise.resolve( null );

			}

			const pendingBufferViews = [];

			if ( accessorDef.bufferView !== undefined ) {

				pendingBufferViews.push( this.getDependency( 'bufferView', accessorDef.bufferView ) );

			} else {

				pendingBufferViews.push( null );

			}

			if ( accessorDef.sparse !== undefined ) {

				pendingBufferViews.push( this.getDependency( 'bufferView', accessorDef.sparse.indices.bufferView ) );
				pendingBufferViews.push( this.getDependency( 'bufferView', accessorDef.sparse.values.bufferView ) );

			}

			return Promise.all( pendingBufferViews ).then( function ( bufferViews ) {

				const bufferView = bufferViews[ 0 ];
				const itemSize = WEBGL_TYPE_SIZES[ accessorDef.type ];
				const TypedArray = WEBGL_COMPONENT_TYPES[ accessorDef.componentType ]; // For VEC3: itemSize is 3, elementBytes is 4, itemBytes is 12.

				const elementBytes = TypedArray.BYTES_PER_ELEMENT;
				const itemBytes = elementBytes * itemSize;
				const byteOffset = accessorDef.byteOffset || 0;
				const byteStride = accessorDef.bufferView !== undefined ? json.bufferViews[ accessorDef.bufferView ].byteStride : undefined;
				const normalized = accessorDef.normalized === true;
				let array, bufferAttribute; // The buffer is not interleaved if the stride is the item size in bytes.

				if ( byteStride && byteStride !== itemBytes ) {

					// Each "slice" of the buffer, as defined by 'count' elements of 'byteStride' bytes, gets its own THREE.InterleavedBuffer
					// This makes sure that IBA.count reflects accessor.count properly
					const ibSlice = Math.floor( byteOffset / byteStride );
					const ibCacheKey = 'InterleavedBuffer:' + accessorDef.bufferView + ':' + accessorDef.componentType + ':' + ibSlice + ':' + accessorDef.count;
					let ib = parser.cache.get( ibCacheKey );

					if ( ! ib ) {

						array = new TypedArray( bufferView, ibSlice * byteStride, accessorDef.count * byteStride / elementBytes ); // Integer parameters to IB/IBA are in array elements, not bytes.

						ib = new THREE.InterleavedBuffer( array, byteStride / elementBytes );
						parser.cache.add( ibCacheKey, ib );

					}

					bufferAttribute = new THREE.InterleavedBufferAttribute( ib, itemSize, byteOffset % byteStride / elementBytes, normalized );

				} else {

					if ( bufferView === null ) {

						array = new TypedArray( accessorDef.count * itemSize );

					} else {

						array = new TypedArray( bufferView, byteOffset, accessorDef.count * itemSize );

					}

					bufferAttribute = new THREE.BufferAttribute( array, itemSize, normalized );

				} // https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#sparse-accessors


				if ( accessorDef.sparse !== undefined ) {

					const itemSizeIndices = WEBGL_TYPE_SIZES.SCALAR;
					const TypedArrayIndices = WEBGL_COMPONENT_TYPES[ accessorDef.sparse.indices.componentType ];
					const byteOffsetIndices = accessorDef.sparse.indices.byteOffset || 0;
					const byteOffsetValues = accessorDef.sparse.values.byteOffset || 0;
					const sparseIndices = new TypedArrayIndices( bufferViews[ 1 ], byteOffsetIndices, accessorDef.sparse.count * itemSizeIndices );
					const sparseValues = new TypedArray( bufferViews[ 2 ], byteOffsetValues, accessorDef.sparse.count * itemSize );

					if ( bufferView !== null ) {

						// Avoid modifying the original ArrayBuffer, if the bufferView wasn't initialized with zeroes.
						bufferAttribute = new THREE.BufferAttribute( bufferAttribute.array.slice(), bufferAttribute.itemSize, bufferAttribute.normalized );

					}

					for ( let i = 0, il = sparseIndices.length; i < il; i ++ ) {

						const index = sparseIndices[ i ];
						bufferAttribute.setX( index, sparseValues[ i * itemSize ] );
						if ( itemSize >= 2 ) bufferAttribute.setY( index, sparseValues[ i * itemSize + 1 ] );
						if ( itemSize >= 3 ) bufferAttribute.setZ( index, sparseValues[ i * itemSize + 2 ] );
						if ( itemSize >= 4 ) bufferAttribute.setW( index, sparseValues[ i * itemSize + 3 ] );
						if ( itemSize >= 5 ) throw new Error( 'THREE.GLTFLoader: Unsupported itemSize in sparse THREE.BufferAttribute.' );

					}

				}

				return bufferAttribute;

			} );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#textures
   * @param {number} textureIndex
   * @return {Promise<THREE.Texture>}
   */


		loadTexture( textureIndex ) {

			const json = this.json;
			const options = this.options;
			const textureDef = json.textures[ textureIndex ];
			const source = json.images[ textureDef.source ];
			let loader = this.textureLoader;

			if ( source.uri ) {

				const handler = options.manager.getHandler( source.uri );
				if ( handler !== null ) loader = handler;

			}

			return this.loadTextureImage( textureIndex, source, loader );

		}

		loadTextureImage( textureIndex, source, loader ) {

			const parser = this;
			const json = this.json;
			const options = this.options;
			const textureDef = json.textures[ textureIndex ];
			const URL = self.URL || self.webkitURL;
			let sourceURI = source.uri;
			let isObjectURL = false;
			let hasAlpha = true;
			if ( source.mimeType === 'image/jpeg' ) hasAlpha = false;

			if ( source.bufferView !== undefined ) {

				// Load binary image data from bufferView, if provided.
				sourceURI = parser.getDependency( 'bufferView', source.bufferView ).then( function ( bufferView ) {

					if ( source.mimeType === 'image/png' ) {

						// Inspect the PNG 'IHDR' chunk to determine whether the image could have an
						// alpha channel. This check is conservative — the image could have an alpha
						// channel with all values == 1, and the indexed type (colorType == 3) only
						// sometimes contains alpha.
						//
						// https://en.wikipedia.org/wiki/Portable_Network_Graphics#File_header
						const colorType = new DataView( bufferView, 25, 1 ).getUint8( 0, false );
						hasAlpha = colorType === 6 || colorType === 4 || colorType === 3;

					}

					isObjectURL = true;
					const blob = new Blob( [ bufferView ], {
						type: source.mimeType
					} );
					sourceURI = URL.createObjectURL( blob );
					return sourceURI;

				} );

			} else if ( source.uri === undefined ) {

				throw new Error( 'THREE.GLTFLoader: Image ' + textureIndex + ' is missing URI and bufferView' );

			}

			return Promise.resolve( sourceURI ).then( function ( sourceURI ) {

				return new Promise( function ( resolve, reject ) {

					let onLoad = resolve;

					if ( loader.isImageBitmapLoader === true ) {

						onLoad = function ( imageBitmap ) {

							resolve( new THREE.CanvasTexture( imageBitmap ) );

						};

					}

					loader.load( resolveURL( sourceURI, options.path ), onLoad, undefined, reject );

				} );

			} ).then( function ( texture ) {

				// Clean up resources and configure Texture.
				if ( isObjectURL === true ) {

					URL.revokeObjectURL( sourceURI );

				}

				texture.flipY = false;
				if ( textureDef.name ) texture.name = textureDef.name; // When there is definitely no alpha channel in the texture, set THREE.RGBFormat to save space.

				if ( ! hasAlpha ) texture.format = THREE.RGBFormat;
				const samplers = json.samplers || {};
				const sampler = samplers[ textureDef.sampler ] || {};
				texture.magFilter = WEBGL_FILTERS[ sampler.magFilter ] || THREE.LinearFilter;
				texture.minFilter = WEBGL_FILTERS[ sampler.minFilter ] || THREE.LinearMipmapLinearFilter;
				texture.wrapS = WEBGL_WRAPPINGS[ sampler.wrapS ] || THREE.RepeatWrapping;
				texture.wrapT = WEBGL_WRAPPINGS[ sampler.wrapT ] || THREE.RepeatWrapping;
				parser.associations.set( texture, {
					type: 'textures',
					index: textureIndex
				} );
				return texture;

			} );

		}
		/**
   * Asynchronously assigns a texture to the given material parameters.
   * @param {Object} materialParams
   * @param {string} mapName
   * @param {Object} mapDef
   * @return {Promise}
   */


		assignTexture( materialParams, mapName, mapDef ) {

			const parser = this;
			return this.getDependency( 'texture', mapDef.index ).then( function ( texture ) {

				// Materials sample aoMap from UV set 1 and other maps from UV set 0 - this can't be configured
				// However, we will copy UV set 0 to UV set 1 on demand for aoMap
				if ( mapDef.texCoord !== undefined && mapDef.texCoord != 0 && ! ( mapName === 'aoMap' && mapDef.texCoord == 1 ) ) {

					console.warn( 'THREE.GLTFLoader: Custom UV set ' + mapDef.texCoord + ' for texture ' + mapName + ' not yet supported.' );

				}

				if ( parser.extensions[ EXTENSIONS.KHR_TEXTURE_TRANSFORM ] ) {

					const transform = mapDef.extensions !== undefined ? mapDef.extensions[ EXTENSIONS.KHR_TEXTURE_TRANSFORM ] : undefined;

					if ( transform ) {

						const gltfReference = parser.associations.get( texture );
						texture = parser.extensions[ EXTENSIONS.KHR_TEXTURE_TRANSFORM ].extendTexture( texture, transform );
						parser.associations.set( texture, gltfReference );

					}

				}

				materialParams[ mapName ] = texture;

			} );

		}
		/**
   * Assigns final material to a THREE.Mesh, THREE.Line, or THREE.Points instance. The instance
   * already has a material (generated from the glTF material options alone)
   * but reuse of the same glTF material may require multiple threejs materials
   * to accommodate different primitive types, defines, etc. New materials will
   * be created if necessary, and reused from a cache.
   * @param  {Object3D} mesh THREE.Mesh, THREE.Line, or THREE.Points instance.
   */


		assignFinalMaterial( mesh ) {

			const geometry = mesh.geometry;
			let material = mesh.material;
			const useVertexTangents = geometry.attributes.tangent !== undefined;
			const useVertexColors = geometry.attributes.color !== undefined;
			const useFlatShading = geometry.attributes.normal === undefined;
			const useSkinning = mesh.isSkinnedMesh === true;
			const useMorphTargets = Object.keys( geometry.morphAttributes ).length > 0;
			const useMorphNormals = useMorphTargets && geometry.morphAttributes.normal !== undefined;

			if ( mesh.isPoints ) {

				const cacheKey = 'PointsMaterial:' + material.uuid;
				let pointsMaterial = this.cache.get( cacheKey );

				if ( ! pointsMaterial ) {

					pointsMaterial = new THREE.PointsMaterial();
					THREE.Material.prototype.copy.call( pointsMaterial, material );
					pointsMaterial.color.copy( material.color );
					pointsMaterial.map = material.map;
					pointsMaterial.sizeAttenuation = false; // glTF spec says points should be 1px

					this.cache.add( cacheKey, pointsMaterial );

				}

				material = pointsMaterial;

			} else if ( mesh.isLine ) {

				const cacheKey = 'LineBasicMaterial:' + material.uuid;
				let lineMaterial = this.cache.get( cacheKey );

				if ( ! lineMaterial ) {

					lineMaterial = new THREE.LineBasicMaterial();
					THREE.Material.prototype.copy.call( lineMaterial, material );
					lineMaterial.color.copy( material.color );
					this.cache.add( cacheKey, lineMaterial );

				}

				material = lineMaterial;

			} // Clone the material if it will be modified


			if ( useVertexTangents || useVertexColors || useFlatShading || useSkinning || useMorphTargets ) {

				let cacheKey = 'ClonedMaterial:' + material.uuid + ':';
				if ( material.isGLTFSpecularGlossinessMaterial ) cacheKey += 'specular-glossiness:';
				if ( useSkinning ) cacheKey += 'skinning:';
				if ( useVertexTangents ) cacheKey += 'vertex-tangents:';
				if ( useVertexColors ) cacheKey += 'vertex-colors:';
				if ( useFlatShading ) cacheKey += 'flat-shading:';
				if ( useMorphTargets ) cacheKey += 'morph-targets:';
				if ( useMorphNormals ) cacheKey += 'morph-normals:';
				let cachedMaterial = this.cache.get( cacheKey );

				if ( ! cachedMaterial ) {

					cachedMaterial = material.clone();
					if ( useSkinning ) cachedMaterial.skinning = true;
					if ( useVertexColors ) cachedMaterial.vertexColors = true;
					if ( useFlatShading ) cachedMaterial.flatShading = true;
					if ( useMorphTargets ) cachedMaterial.morphTargets = true;
					if ( useMorphNormals ) cachedMaterial.morphNormals = true;

					if ( useVertexTangents ) {

						cachedMaterial.vertexTangents = true; // https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995

						if ( cachedMaterial.normalScale ) cachedMaterial.normalScale.y *= - 1;
						if ( cachedMaterial.clearcoatNormalScale ) cachedMaterial.clearcoatNormalScale.y *= - 1;

					}

					this.cache.add( cacheKey, cachedMaterial );
					this.associations.set( cachedMaterial, this.associations.get( material ) );

				}

				material = cachedMaterial;

			} // workarounds for mesh and geometry


			if ( material.aoMap && geometry.attributes.uv2 === undefined && geometry.attributes.uv !== undefined ) {

				geometry.setAttribute( 'uv2', geometry.attributes.uv );

			}

			mesh.material = material;

		}

		getMaterialType( ) {

			return THREE.MeshStandardMaterial;

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#materials
   * @param {number} materialIndex
   * @return {Promise<Material>}
   */


		loadMaterial( materialIndex ) {

			const parser = this;
			const json = this.json;
			const extensions = this.extensions;
			const materialDef = json.materials[ materialIndex ];
			let materialType;
			const materialParams = {};
			const materialExtensions = materialDef.extensions || {};
			const pending = [];

			if ( materialExtensions[ EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS ] ) {

				const sgExtension = extensions[ EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS ];
				materialType = sgExtension.getMaterialType();
				pending.push( sgExtension.extendParams( materialParams, materialDef, parser ) );

			} else if ( materialExtensions[ EXTENSIONS.KHR_MATERIALS_UNLIT ] ) {

				const kmuExtension = extensions[ EXTENSIONS.KHR_MATERIALS_UNLIT ];
				materialType = kmuExtension.getMaterialType();
				pending.push( kmuExtension.extendParams( materialParams, materialDef, parser ) );

			} else {

				// Specification:
				// https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#metallic-roughness-material
				const metallicRoughness = materialDef.pbrMetallicRoughness || {};
				materialParams.color = new THREE.Color( 1.0, 1.0, 1.0 );
				materialParams.opacity = 1.0;

				if ( Array.isArray( metallicRoughness.baseColorFactor ) ) {

					const array = metallicRoughness.baseColorFactor;
					materialParams.color.fromArray( array );
					materialParams.opacity = array[ 3 ];

				}

				if ( metallicRoughness.baseColorTexture !== undefined ) {

					pending.push( parser.assignTexture( materialParams, 'map', metallicRoughness.baseColorTexture ) );

				}

				materialParams.metalness = metallicRoughness.metallicFactor !== undefined ? metallicRoughness.metallicFactor : 1.0;
				materialParams.roughness = metallicRoughness.roughnessFactor !== undefined ? metallicRoughness.roughnessFactor : 1.0;

				if ( metallicRoughness.metallicRoughnessTexture !== undefined ) {

					pending.push( parser.assignTexture( materialParams, 'metalnessMap', metallicRoughness.metallicRoughnessTexture ) );
					pending.push( parser.assignTexture( materialParams, 'roughnessMap', metallicRoughness.metallicRoughnessTexture ) );

				}

				materialType = this._invokeOne( function ( ext ) {

					return ext.getMaterialType && ext.getMaterialType( materialIndex );

				} );
				pending.push( Promise.all( this._invokeAll( function ( ext ) {

					return ext.extendMaterialParams && ext.extendMaterialParams( materialIndex, materialParams );

				} ) ) );

			}

			if ( materialDef.doubleSided === true ) {

				materialParams.side = THREE.DoubleSide;

			}

			const alphaMode = materialDef.alphaMode || ALPHA_MODES.OPAQUE;

			if ( alphaMode === ALPHA_MODES.BLEND ) {

				materialParams.transparent = true; // See: https://github.com/mrdoob/three.js/issues/17706

				materialParams.depthWrite = false;

			} else {

				materialParams.transparent = false;

				if ( alphaMode === ALPHA_MODES.MASK ) {

					materialParams.alphaTest = materialDef.alphaCutoff !== undefined ? materialDef.alphaCutoff : 0.5;

				}

			}

			if ( materialDef.normalTexture !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				pending.push( parser.assignTexture( materialParams, 'normalMap', materialDef.normalTexture ) ); // https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995

				materialParams.normalScale = new THREE.Vector2( 1, - 1 );

				if ( materialDef.normalTexture.scale !== undefined ) {

					materialParams.normalScale.set( materialDef.normalTexture.scale, - materialDef.normalTexture.scale );

				}

			}

			if ( materialDef.occlusionTexture !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				pending.push( parser.assignTexture( materialParams, 'aoMap', materialDef.occlusionTexture ) );

				if ( materialDef.occlusionTexture.strength !== undefined ) {

					materialParams.aoMapIntensity = materialDef.occlusionTexture.strength;

				}

			}

			if ( materialDef.emissiveFactor !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				materialParams.emissive = new THREE.Color().fromArray( materialDef.emissiveFactor );

			}

			if ( materialDef.emissiveTexture !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				pending.push( parser.assignTexture( materialParams, 'emissiveMap', materialDef.emissiveTexture ) );

			}

			return Promise.all( pending ).then( function () {

				let material;

				if ( materialType === GLTFMeshStandardSGMaterial ) {

					material = extensions[ EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS ].createMaterial( materialParams );

				} else {

					material = new materialType( materialParams );

				}

				if ( materialDef.name ) material.name = materialDef.name; // baseColorTexture, emissiveTexture, and specularGlossinessTexture use sRGB encoding.

				if ( material.map ) material.map.encoding = THREE.sRGBEncoding;
				if ( material.emissiveMap ) material.emissiveMap.encoding = THREE.sRGBEncoding;
				assignExtrasToUserData( material, materialDef );
				parser.associations.set( material, {
					type: 'materials',
					index: materialIndex
				} );
				if ( materialDef.extensions ) addUnknownExtensionsToUserData( extensions, material, materialDef );
				return material;

			} );

		}
		/** When THREE.Object3D instances are targeted by animation, they need unique names. */


		createUniqueName( originalName ) {

			const sanitizedName = THREE.PropertyBinding.sanitizeNodeName( originalName || '' );
			let name = sanitizedName;

			for ( let i = 1; this.nodeNamesUsed[ name ]; ++ i ) {

				name = sanitizedName + '_' + i;

			}

			this.nodeNamesUsed[ name ] = true;
			return name;

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#geometry
   *
   * Creates BufferGeometries from primitives.
   *
   * @param {Array<GLTF.Primitive>} primitives
   * @return {Promise<Array<BufferGeometry>>}
   */


		loadGeometries( primitives ) {

			const parser = this;
			const extensions = this.extensions;
			const cache = this.primitiveCache;

			function createDracoPrimitive( primitive ) {

				return extensions[ EXTENSIONS.KHR_DRACO_MESH_COMPRESSION ].decodePrimitive( primitive, parser ).then( function ( geometry ) {

					return addPrimitiveAttributes( geometry, primitive, parser );

				} );

			}

			const pending = [];

			for ( let i = 0, il = primitives.length; i < il; i ++ ) {

				const primitive = primitives[ i ];
				const cacheKey = createPrimitiveKey( primitive ); // See if we've already created this geometry

				const cached = cache[ cacheKey ];

				if ( cached ) {

					// Use the cached geometry if it exists
					pending.push( cached.promise );

				} else {

					let geometryPromise;

					if ( primitive.extensions && primitive.extensions[ EXTENSIONS.KHR_DRACO_MESH_COMPRESSION ] ) {

						// Use DRACO geometry if available
						geometryPromise = createDracoPrimitive( primitive );

					} else {

						// Otherwise create a new geometry
						geometryPromise = addPrimitiveAttributes( new THREE.BufferGeometry(), primitive, parser );

					} // Cache this geometry


					cache[ cacheKey ] = {
						primitive: primitive,
						promise: geometryPromise
					};
					pending.push( geometryPromise );

				}

			}

			return Promise.all( pending );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#meshes
   * @param {number} meshIndex
   * @return {Promise<Group|Mesh|SkinnedMesh>}
   */


		loadMesh( meshIndex ) {

			const parser = this;
			const json = this.json;
			const extensions = this.extensions;
			const meshDef = json.meshes[ meshIndex ];
			const primitives = meshDef.primitives;
			const pending = [];

			for ( let i = 0, il = primitives.length; i < il; i ++ ) {

				const material = primitives[ i ].material === undefined ? createDefaultMaterial( this.cache ) : this.getDependency( 'material', primitives[ i ].material );
				pending.push( material );

			}

			pending.push( parser.loadGeometries( primitives ) );
			return Promise.all( pending ).then( function ( results ) {

				const materials = results.slice( 0, results.length - 1 );
				const geometries = results[ results.length - 1 ];
				const meshes = [];

				for ( let i = 0, il = geometries.length; i < il; i ++ ) {

					const geometry = geometries[ i ];
					const primitive = primitives[ i ]; // 1. create THREE.Mesh

					let mesh;
					const material = materials[ i ];

					if ( primitive.mode === WEBGL_CONSTANTS.TRIANGLES || primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP || primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN || primitive.mode === undefined ) {

						// .isSkinnedMesh isn't in glTF spec. See ._markDefs()
						mesh = meshDef.isSkinnedMesh === true ? new THREE.SkinnedMesh( geometry, material ) : new THREE.Mesh( geometry, material );

						if ( mesh.isSkinnedMesh === true && ! mesh.geometry.attributes.skinWeight.normalized ) {

							// we normalize floating point skin weight array to fix malformed assets (see #15319)
							// it's important to skip this for non-float32 data since normalizeSkinWeights assumes non-normalized inputs
							mesh.normalizeSkinWeights();

						}

						if ( primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP ) {

							mesh.geometry = toTrianglesDrawMode( mesh.geometry, THREE.TriangleStripDrawMode );

						} else if ( primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN ) {

							mesh.geometry = toTrianglesDrawMode( mesh.geometry, THREE.TriangleFanDrawMode );

						}

					} else if ( primitive.mode === WEBGL_CONSTANTS.LINES ) {

						mesh = new THREE.LineSegments( geometry, material );

					} else if ( primitive.mode === WEBGL_CONSTANTS.LINE_STRIP ) {

						mesh = new THREE.Line( geometry, material );

					} else if ( primitive.mode === WEBGL_CONSTANTS.LINE_LOOP ) {

						mesh = new THREE.LineLoop( geometry, material );

					} else if ( primitive.mode === WEBGL_CONSTANTS.POINTS ) {

						mesh = new THREE.Points( geometry, material );

					} else {

						throw new Error( 'THREE.GLTFLoader: Primitive mode unsupported: ' + primitive.mode );

					}

					if ( Object.keys( mesh.geometry.morphAttributes ).length > 0 ) {

						updateMorphTargets( mesh, meshDef );

					}

					mesh.name = parser.createUniqueName( meshDef.name || 'mesh_' + meshIndex );
					assignExtrasToUserData( mesh, meshDef );
					if ( primitive.extensions ) addUnknownExtensionsToUserData( extensions, mesh, primitive );
					parser.assignFinalMaterial( mesh );
					meshes.push( mesh );

				}

				if ( meshes.length === 1 ) {

					return meshes[ 0 ];

				}

				const group = new THREE.Group();

				for ( let i = 0, il = meshes.length; i < il; i ++ ) {

					group.add( meshes[ i ] );

				}

				return group;

			} );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#cameras
   * @param {number} cameraIndex
   * @return {Promise<THREE.Camera>}
   */


		loadCamera( cameraIndex ) {

			let camera;
			const cameraDef = this.json.cameras[ cameraIndex ];
			const params = cameraDef[ cameraDef.type ];

			if ( ! params ) {

				console.warn( 'THREE.GLTFLoader: Missing camera parameters.' );
				return;

			}

			if ( cameraDef.type === 'perspective' ) {

				camera = new THREE.PerspectiveCamera( THREE.MathUtils.radToDeg( params.yfov ), params.aspectRatio || 1, params.znear || 1, params.zfar || 2e6 );

			} else if ( cameraDef.type === 'orthographic' ) {

				camera = new THREE.OrthographicCamera( - params.xmag, params.xmag, params.ymag, - params.ymag, params.znear, params.zfar );

			}

			if ( cameraDef.name ) camera.name = this.createUniqueName( cameraDef.name );
			assignExtrasToUserData( camera, cameraDef );
			return Promise.resolve( camera );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#skins
   * @param {number} skinIndex
   * @return {Promise<Object>}
   */


		loadSkin( skinIndex ) {

			const skinDef = this.json.skins[ skinIndex ];
			const skinEntry = {
				joints: skinDef.joints
			};

			if ( skinDef.inverseBindMatrices === undefined ) {

				return Promise.resolve( skinEntry );

			}

			return this.getDependency( 'accessor', skinDef.inverseBindMatrices ).then( function ( accessor ) {

				skinEntry.inverseBindMatrices = accessor;
				return skinEntry;

			} );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#animations
   * @param {number} animationIndex
   * @return {Promise<AnimationClip>}
   */


		loadAnimation( animationIndex ) {

			const json = this.json;
			const animationDef = json.animations[ animationIndex ];
			const pendingNodes = [];
			const pendingInputAccessors = [];
			const pendingOutputAccessors = [];
			const pendingSamplers = [];
			const pendingTargets = [];

			for ( let i = 0, il = animationDef.channels.length; i < il; i ++ ) {

				const channel = animationDef.channels[ i ];
				const sampler = animationDef.samplers[ channel.sampler ];
				const target = channel.target;
				const name = target.node !== undefined ? target.node : target.id; // NOTE: target.id is deprecated.

				const input = animationDef.parameters !== undefined ? animationDef.parameters[ sampler.input ] : sampler.input;
				const output = animationDef.parameters !== undefined ? animationDef.parameters[ sampler.output ] : sampler.output;
				pendingNodes.push( this.getDependency( 'node', name ) );
				pendingInputAccessors.push( this.getDependency( 'accessor', input ) );
				pendingOutputAccessors.push( this.getDependency( 'accessor', output ) );
				pendingSamplers.push( sampler );
				pendingTargets.push( target );

			}

			return Promise.all( [ Promise.all( pendingNodes ), Promise.all( pendingInputAccessors ), Promise.all( pendingOutputAccessors ), Promise.all( pendingSamplers ), Promise.all( pendingTargets ) ] ).then( function ( dependencies ) {

				const nodes = dependencies[ 0 ];
				const inputAccessors = dependencies[ 1 ];
				const outputAccessors = dependencies[ 2 ];
				const samplers = dependencies[ 3 ];
				const targets = dependencies[ 4 ];
				const tracks = [];

				for ( let i = 0, il = nodes.length; i < il; i ++ ) {

					const node = nodes[ i ];
					const inputAccessor = inputAccessors[ i ];
					const outputAccessor = outputAccessors[ i ];
					const sampler = samplers[ i ];
					const target = targets[ i ];
					if ( node === undefined ) continue;
					node.updateMatrix();
					node.matrixAutoUpdate = true;
					let TypedKeyframeTrack;

					switch ( PATH_PROPERTIES[ target.path ] ) {

						case PATH_PROPERTIES.weights:
							TypedKeyframeTrack = THREE.NumberKeyframeTrack;
							break;

						case PATH_PROPERTIES.rotation:
							TypedKeyframeTrack = THREE.QuaternionKeyframeTrack;
							break;

						case PATH_PROPERTIES.position:
						case PATH_PROPERTIES.scale:
						default:
							TypedKeyframeTrack = THREE.VectorKeyframeTrack;
							break;

					}

					const targetName = node.name ? node.name : node.uuid;
					const interpolation = sampler.interpolation !== undefined ? INTERPOLATION[ sampler.interpolation ] : THREE.InterpolateLinear;
					const targetNames = [];

					if ( PATH_PROPERTIES[ target.path ] === PATH_PROPERTIES.weights ) {

						// Node may be a THREE.Group (glTF mesh with several primitives) or a THREE.Mesh.
						node.traverse( function ( object ) {

							if ( object.isMesh === true && object.morphTargetInfluences ) {

								targetNames.push( object.name ? object.name : object.uuid );

							}

						} );

					} else {

						targetNames.push( targetName );

					}

					let outputArray = outputAccessor.array;

					if ( outputAccessor.normalized ) {

						const scale = getNormalizedComponentScale( outputArray.constructor );
						const scaled = new Float32Array( outputArray.length );

						for ( let j = 0, jl = outputArray.length; j < jl; j ++ ) {

							scaled[ j ] = outputArray[ j ] * scale;

						}

						outputArray = scaled;

					}

					for ( let j = 0, jl = targetNames.length; j < jl; j ++ ) {

						const track = new TypedKeyframeTrack( targetNames[ j ] + '.' + PATH_PROPERTIES[ target.path ], inputAccessor.array, outputArray, interpolation ); // Override interpolation with custom factory method.

						if ( sampler.interpolation === 'CUBICSPLINE' ) {

							track.createInterpolant = function InterpolantFactoryMethodGLTFCubicSpline( result ) {

								// A CUBICSPLINE keyframe in glTF has three output values for each input value,
								// representing inTangent, splineVertex, and outTangent. As a result, track.getValueSize()
								// must be divided by three to get the interpolant's sampleSize argument.
								return new GLTFCubicSplineInterpolant( this.times, this.values, this.getValueSize() / 3, result );

							}; // Mark as CUBICSPLINE. `track.getInterpolation()` doesn't support custom interpolants.


							track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline = true;

						}

						tracks.push( track );

					}

				}

				const name = animationDef.name ? animationDef.name : 'animation_' + animationIndex;
				return new THREE.AnimationClip( name, undefined, tracks );

			} );

		}

		createNodeMesh( nodeIndex ) {

			const json = this.json;
			const parser = this;
			const nodeDef = json.nodes[ nodeIndex ];
			if ( nodeDef.mesh === undefined ) return null;
			return parser.getDependency( 'mesh', nodeDef.mesh ).then( function ( mesh ) {

				const node = parser._getNodeRef( parser.meshCache, nodeDef.mesh, mesh ); // if weights are provided on the node, override weights on the mesh.


				if ( nodeDef.weights !== undefined ) {

					node.traverse( function ( o ) {

						if ( ! o.isMesh ) return;

						for ( let i = 0, il = nodeDef.weights.length; i < il; i ++ ) {

							o.morphTargetInfluences[ i ] = nodeDef.weights[ i ];

						}

					} );

				}

				return node;

			} );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#nodes-and-hierarchy
   * @param {number} nodeIndex
   * @return {Promise<Object3D>}
   */


		loadNode( nodeIndex ) {

			const json = this.json;
			const extensions = this.extensions;
			const parser = this;
			const nodeDef = json.nodes[ nodeIndex ]; // reserve node's name before its dependencies, so the root has the intended name.

			const nodeName = nodeDef.name ? parser.createUniqueName( nodeDef.name ) : '';
			return function () {

				const pending = [];

				const meshPromise = parser._invokeOne( function ( ext ) {

					return ext.createNodeMesh && ext.createNodeMesh( nodeIndex );

				} );

				if ( meshPromise ) {

					pending.push( meshPromise );

				}

				if ( nodeDef.camera !== undefined ) {

					pending.push( parser.getDependency( 'camera', nodeDef.camera ).then( function ( camera ) {

						return parser._getNodeRef( parser.cameraCache, nodeDef.camera, camera );

					} ) );

				}

				parser._invokeAll( function ( ext ) {

					return ext.createNodeAttachment && ext.createNodeAttachment( nodeIndex );

				} ).forEach( function ( promise ) {

					pending.push( promise );

				} );

				return Promise.all( pending );

			}().then( function ( objects ) {

				let node; // .isBone isn't in glTF spec. See ._markDefs

				if ( nodeDef.isBone === true ) {

					node = new THREE.Bone();

				} else if ( objects.length > 1 ) {

					node = new THREE.Group();

				} else if ( objects.length === 1 ) {

					node = objects[ 0 ];

				} else {

					node = new THREE.Object3D();

				}

				if ( node !== objects[ 0 ] ) {

					for ( let i = 0, il = objects.length; i < il; i ++ ) {

						node.add( objects[ i ] );

					}

				}

				if ( nodeDef.name ) {

					node.userData.name = nodeDef.name;
					node.name = nodeName;

				}

				assignExtrasToUserData( node, nodeDef );
				if ( nodeDef.extensions ) addUnknownExtensionsToUserData( extensions, node, nodeDef );

				if ( nodeDef.matrix !== undefined ) {

					const matrix = new THREE.Matrix4();
					matrix.fromArray( nodeDef.matrix );
					node.applyMatrix4( matrix );

				} else {

					if ( nodeDef.translation !== undefined ) {

						node.position.fromArray( nodeDef.translation );

					}

					if ( nodeDef.rotation !== undefined ) {

						node.quaternion.fromArray( nodeDef.rotation );

					}

					if ( nodeDef.scale !== undefined ) {

						node.scale.fromArray( nodeDef.scale );

					}

				}

				parser.associations.set( node, {
					type: 'nodes',
					index: nodeIndex
				} );
				return node;

			} );

		}
		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#scenes
   * @param {number} sceneIndex
   * @return {Promise<Group>}
   */


		loadScene( sceneIndex ) {

			const json = this.json;
			const extensions = this.extensions;
			const sceneDef = this.json.scenes[ sceneIndex ];
			const parser = this; // THREE.Loader returns THREE.Group, not Scene.
			// See: https://github.com/mrdoob/three.js/issues/18342#issuecomment-578981172

			const scene = new THREE.Group();
			if ( sceneDef.name ) scene.name = parser.createUniqueName( sceneDef.name );
			assignExtrasToUserData( scene, sceneDef );
			if ( sceneDef.extensions ) addUnknownExtensionsToUserData( extensions, scene, sceneDef );
			const nodeIds = sceneDef.nodes || [];
			const pending = [];

			for ( let i = 0, il = nodeIds.length; i < il; i ++ ) {

				pending.push( buildNodeHierachy( nodeIds[ i ], scene, json, parser ) );

			}

			return Promise.all( pending ).then( function () {

				return scene;

			} );

		}

	}

	function buildNodeHierachy( nodeId, parentObject, json, parser ) {

		const nodeDef = json.nodes[ nodeId ];
		return parser.getDependency( 'node', nodeId ).then( function ( node ) {

			if ( nodeDef.skin === undefined ) return node; // build skeleton here as well

			let skinEntry;
			return parser.getDependency( 'skin', nodeDef.skin ).then( function ( skin ) {

				skinEntry = skin;
				const pendingJoints = [];

				for ( let i = 0, il = skinEntry.joints.length; i < il; i ++ ) {

					pendingJoints.push( parser.getDependency( 'node', skinEntry.joints[ i ] ) );

				}

				return Promise.all( pendingJoints );

			} ).then( function ( jointNodes ) {

				node.traverse( function ( mesh ) {

					if ( ! mesh.isMesh ) return;
					const bones = [];
					const boneInverses = [];

					for ( let j = 0, jl = jointNodes.length; j < jl; j ++ ) {

						const jointNode = jointNodes[ j ];

						if ( jointNode ) {

							bones.push( jointNode );
							const mat = new THREE.Matrix4();

							if ( skinEntry.inverseBindMatrices !== undefined ) {

								mat.fromArray( skinEntry.inverseBindMatrices.array, j * 16 );

							}

							boneInverses.push( mat );

						} else {

							console.warn( 'THREE.GLTFLoader: Joint "%s" could not be found.', skinEntry.joints[ j ] );

						}

					}

					mesh.bind( new THREE.Skeleton( bones, boneInverses ), mesh.matrixWorld );

				} );
				return node;

			} );

		} ).then( function ( node ) {

			// build node hierachy
			parentObject.add( node );
			const pending = [];

			if ( nodeDef.children ) {

				const children = nodeDef.children;

				for ( let i = 0, il = children.length; i < il; i ++ ) {

					const child = children[ i ];
					pending.push( buildNodeHierachy( child, node, json, parser ) );

				}

			}

			return Promise.all( pending );

		} );

	}
	/**
 * @param {BufferGeometry} geometry
 * @param {GLTF.Primitive} primitiveDef
 * @param {GLTFParser} parser
 */


	function computeBounds( geometry, primitiveDef, parser ) {

		const attributes = primitiveDef.attributes;
		const box = new THREE.Box3();

		if ( attributes.POSITION !== undefined ) {

			const accessor = parser.json.accessors[ attributes.POSITION ];
			const min = accessor.min;
			const max = accessor.max; // glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

			if ( min !== undefined && max !== undefined ) {

				box.set( new THREE.Vector3( min[ 0 ], min[ 1 ], min[ 2 ] ), new THREE.Vector3( max[ 0 ], max[ 1 ], max[ 2 ] ) );

				if ( accessor.normalized ) {

					const boxScale = getNormalizedComponentScale( WEBGL_COMPONENT_TYPES[ accessor.componentType ] );
					box.min.multiplyScalar( boxScale );
					box.max.multiplyScalar( boxScale );

				}

			} else {

				console.warn( 'THREE.GLTFLoader: Missing min/max properties for accessor POSITION.' );
				return;

			}

		} else {

			return;

		}

		const targets = primitiveDef.targets;

		if ( targets !== undefined ) {

			const maxDisplacement = new THREE.Vector3();
			const vector = new THREE.Vector3();

			for ( let i = 0, il = targets.length; i < il; i ++ ) {

				const target = targets[ i ];

				if ( target.POSITION !== undefined ) {

					const accessor = parser.json.accessors[ target.POSITION ];
					const min = accessor.min;
					const max = accessor.max; // glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

					if ( min !== undefined && max !== undefined ) {

						// we need to get max of absolute components because target weight is [-1,1]
						vector.setX( Math.max( Math.abs( min[ 0 ] ), Math.abs( max[ 0 ] ) ) );
						vector.setY( Math.max( Math.abs( min[ 1 ] ), Math.abs( max[ 1 ] ) ) );
						vector.setZ( Math.max( Math.abs( min[ 2 ] ), Math.abs( max[ 2 ] ) ) );

						if ( accessor.normalized ) {

							const boxScale = getNormalizedComponentScale( WEBGL_COMPONENT_TYPES[ accessor.componentType ] );
							vector.multiplyScalar( boxScale );

						} // Note: this assumes that the sum of all weights is at most 1. This isn't quite correct - it's more conservative
						// to assume that each target can have a max weight of 1. However, for some use cases - notably, when morph targets
						// are used to implement key-frame animations and as such only two are active at a time - this results in very large
						// boxes. So for now we make a box that's sometimes a touch too small but is hopefully mostly of reasonable size.


						maxDisplacement.max( vector );

					} else {

						console.warn( 'THREE.GLTFLoader: Missing min/max properties for accessor POSITION.' );

					}

				}

			} // As per comment above this box isn't conservative, but has a reasonable size for a very large number of morph targets.


			box.expandByVector( maxDisplacement );

		}

		geometry.boundingBox = box;
		const sphere = new THREE.Sphere();
		box.getCenter( sphere.center );
		sphere.radius = box.min.distanceTo( box.max ) / 2;
		geometry.boundingSphere = sphere;

	}
	/**
 * @param {BufferGeometry} geometry
 * @param {GLTF.Primitive} primitiveDef
 * @param {GLTFParser} parser
 * @return {Promise<BufferGeometry>}
 */


	function addPrimitiveAttributes( geometry, primitiveDef, parser ) {

		const attributes = primitiveDef.attributes;
		const pending = [];

		function assignAttributeAccessor( accessorIndex, attributeName ) {

			return parser.getDependency( 'accessor', accessorIndex ).then( function ( accessor ) {

				geometry.setAttribute( attributeName, accessor );

			} );

		}

		for ( const gltfAttributeName in attributes ) {

			const threeAttributeName = ATTRIBUTES[ gltfAttributeName ] || gltfAttributeName.toLowerCase(); // Skip attributes already provided by e.g. Draco extension.

			if ( threeAttributeName in geometry.attributes ) continue;
			pending.push( assignAttributeAccessor( attributes[ gltfAttributeName ], threeAttributeName ) );

		}

		if ( primitiveDef.indices !== undefined && ! geometry.index ) {

			const accessor = parser.getDependency( 'accessor', primitiveDef.indices ).then( function ( accessor ) {

				geometry.setIndex( accessor );

			} );
			pending.push( accessor );

		}

		assignExtrasToUserData( geometry, primitiveDef );
		computeBounds( geometry, primitiveDef, parser );
		return Promise.all( pending ).then( function () {

			return primitiveDef.targets !== undefined ? addMorphTargets( geometry, primitiveDef.targets, parser ) : geometry;

		} );

	}
	/**
 * @param {BufferGeometry} geometry
 * @param {Number} drawMode
 * @return {BufferGeometry}
 */


	function toTrianglesDrawMode( geometry, drawMode ) {

		let index = geometry.getIndex(); // generate index if not present

		if ( index === null ) {

			const indices = [];
			const position = geometry.getAttribute( 'position' );

			if ( position !== undefined ) {

				for ( let i = 0; i < position.count; i ++ ) {

					indices.push( i );

				}

				geometry.setIndex( indices );
				index = geometry.getIndex();

			} else {

				console.error( 'THREE.GLTFLoader.toTrianglesDrawMode(): Undefined position attribute. Processing not possible.' );
				return geometry;

			}

		} //


		const numberOfTriangles = index.count - 2;
		const newIndices = [];

		if ( drawMode === THREE.TriangleFanDrawMode ) {

			// gl.TRIANGLE_FAN
			for ( let i = 1; i <= numberOfTriangles; i ++ ) {

				newIndices.push( index.getX( 0 ) );
				newIndices.push( index.getX( i ) );
				newIndices.push( index.getX( i + 1 ) );

			}

		} else {

			// gl.TRIANGLE_STRIP
			for ( let i = 0; i < numberOfTriangles; i ++ ) {

				if ( i % 2 === 0 ) {

					newIndices.push( index.getX( i ) );
					newIndices.push( index.getX( i + 1 ) );
					newIndices.push( index.getX( i + 2 ) );

				} else {

					newIndices.push( index.getX( i + 2 ) );
					newIndices.push( index.getX( i + 1 ) );
					newIndices.push( index.getX( i ) );

				}

			}

		}

		if ( newIndices.length / 3 !== numberOfTriangles ) {

			console.error( 'THREE.GLTFLoader.toTrianglesDrawMode(): Unable to generate correct amount of triangles.' );

		} // build final geometry


		const newGeometry = geometry.clone();
		newGeometry.setIndex( newIndices );
		return newGeometry;

	}

	THREE.GLTFLoader = GLTFLoader;

} )();

/* --- three/examples/js/loaders/RGBELoader.js --- */
( function () {

	// http://en.wikipedia.org/wiki/RGBE_image_format

	class RGBELoader extends THREE.DataTextureLoader {

		constructor( manager ) {

			super( manager );
			this.type = THREE.UnsignedByteType;

		} // adapted from http://www.graphics.cornell.edu/~bjw/rgbe.html


		parse( buffer ) {

			const
				/* return codes for rgbe routines */
				//RGBE_RETURN_SUCCESS = 0,
				RGBE_RETURN_FAILURE = - 1,

				/* default error routine.  change this to change error handling */
				rgbe_read_error = 1,
				rgbe_write_error = 2,
				rgbe_format_error = 3,
				rgbe_memory_error = 4,
				rgbe_error = function ( rgbe_error_code, msg ) {

					switch ( rgbe_error_code ) {

						case rgbe_read_error:
							console.error( 'THREE.RGBELoader Read Error: ' + ( msg || '' ) );
							break;

						case rgbe_write_error:
							console.error( 'THREE.RGBELoader Write Error: ' + ( msg || '' ) );
							break;

						case rgbe_format_error:
							console.error( 'THREE.RGBELoader Bad File Format: ' + ( msg || '' ) );
							break;

						default:
						case rgbe_memory_error:
							console.error( 'THREE.RGBELoader: Error: ' + ( msg || '' ) );

					}

					return RGBE_RETURN_FAILURE;

				},

				/* offsets to red, green, and blue components in a data (float) pixel */
				//RGBE_DATA_RED = 0,
				//RGBE_DATA_GREEN = 1,
				//RGBE_DATA_BLUE = 2,

				/* number of floats per pixel, use 4 since stored in rgba image format */
				//RGBE_DATA_SIZE = 4,

				/* flags indicating which fields in an rgbe_header_info are valid */
				RGBE_VALID_PROGRAMTYPE = 1,
				RGBE_VALID_FORMAT = 2,
				RGBE_VALID_DIMENSIONS = 4,
				NEWLINE = '\n',
				fgets = function ( buffer, lineLimit, consume ) {

					const chunkSize = 128;
					lineLimit = ! lineLimit ? 1024 : lineLimit;
					let p = buffer.pos,
						i = - 1,
						len = 0,
						s = '',
						chunk = String.fromCharCode.apply( null, new Uint16Array( buffer.subarray( p, p + chunkSize ) ) );

					while ( 0 > ( i = chunk.indexOf( NEWLINE ) ) && len < lineLimit && p < buffer.byteLength ) {

						s += chunk;
						len += chunk.length;
						p += chunkSize;
						chunk += String.fromCharCode.apply( null, new Uint16Array( buffer.subarray( p, p + chunkSize ) ) );

					}

					if ( - 1 < i ) {

						/*for (i=l-1; i>=0; i--) {
        	byteCode = m.charCodeAt(i);
        	if (byteCode > 0x7f && byteCode <= 0x7ff) byteLen++;
        	else if (byteCode > 0x7ff && byteCode <= 0xffff) byteLen += 2;
        	if (byteCode >= 0xDC00 && byteCode <= 0xDFFF) i--; //trail surrogate
        }*/
						if ( false !== consume ) buffer.pos += len + i + 1;
						return s + chunk.slice( 0, i );

					}

					return false;

				},

				/* minimal header reading.  modify if you want to parse more information */
				RGBE_ReadHeader = function ( buffer ) {

					// regexes to parse header info fields
					const magic_token_re = /^#\?(\S+)/,
						gamma_re = /^\s*GAMMA\s*=\s*(\d+(\.\d+)?)\s*$/,
						exposure_re = /^\s*EXPOSURE\s*=\s*(\d+(\.\d+)?)\s*$/,
						format_re = /^\s*FORMAT=(\S+)\s*$/,
						dimensions_re = /^\s*\-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/,
						// RGBE format header struct
						header = {
							valid: 0,

							/* indicate which fields are valid */
							string: '',

							/* the actual header string */
							comments: '',

							/* comments found in header */
							programtype: 'RGBE',

							/* listed at beginning of file to identify it after "#?". defaults to "RGBE" */
							format: '',

							/* RGBE format, default 32-bit_rle_rgbe */
							gamma: 1.0,

							/* image has already been gamma corrected with given gamma. defaults to 1.0 (no correction) */
							exposure: 1.0,

							/* a value of 1.0 in an image corresponds to <exposure> watts/steradian/m^2. defaults to 1.0 */
							width: 0,
							height: 0
							/* image dimensions, width/height */

						};
					let line, match;

					if ( buffer.pos >= buffer.byteLength || ! ( line = fgets( buffer ) ) ) {

						return rgbe_error( rgbe_read_error, 'no header found' );

					}
					/* if you want to require the magic token then uncomment the next line */


					if ( ! ( match = line.match( magic_token_re ) ) ) {

						return rgbe_error( rgbe_format_error, 'bad initial token' );

					}

					header.valid |= RGBE_VALID_PROGRAMTYPE;
					header.programtype = match[ 1 ];
					header.string += line + '\n';

					while ( true ) {

						line = fgets( buffer );
						if ( false === line ) break;
						header.string += line + '\n';

						if ( '#' === line.charAt( 0 ) ) {

							header.comments += line + '\n';
							continue; // comment line

						}

						if ( match = line.match( gamma_re ) ) {

							header.gamma = parseFloat( match[ 1 ], 10 );

						}

						if ( match = line.match( exposure_re ) ) {

							header.exposure = parseFloat( match[ 1 ], 10 );

						}

						if ( match = line.match( format_re ) ) {

							header.valid |= RGBE_VALID_FORMAT;
							header.format = match[ 1 ]; //'32-bit_rle_rgbe';

						}

						if ( match = line.match( dimensions_re ) ) {

							header.valid |= RGBE_VALID_DIMENSIONS;
							header.height = parseInt( match[ 1 ], 10 );
							header.width = parseInt( match[ 2 ], 10 );

						}

						if ( header.valid & RGBE_VALID_FORMAT && header.valid & RGBE_VALID_DIMENSIONS ) break;

					}

					if ( ! ( header.valid & RGBE_VALID_FORMAT ) ) {

						return rgbe_error( rgbe_format_error, 'missing format specifier' );

					}

					if ( ! ( header.valid & RGBE_VALID_DIMENSIONS ) ) {

						return rgbe_error( rgbe_format_error, 'missing image size specifier' );

					}

					return header;

				},
				RGBE_ReadPixels_RLE = function ( buffer, w, h ) {

					const scanline_width = w;

					if ( // run length encoding is not allowed so read flat
						scanline_width < 8 || scanline_width > 0x7fff || // this file is not run length encoded
      2 !== buffer[ 0 ] || 2 !== buffer[ 1 ] || buffer[ 2 ] & 0x80 ) {

						// return the flat buffer
						return new Uint8Array( buffer );

					}

					if ( scanline_width !== ( buffer[ 2 ] << 8 | buffer[ 3 ] ) ) {

						return rgbe_error( rgbe_format_error, 'wrong scanline width' );

					}

					const data_rgba = new Uint8Array( 4 * w * h );

					if ( ! data_rgba.length ) {

						return rgbe_error( rgbe_memory_error, 'unable to allocate buffer space' );

					}

					let offset = 0,
						pos = 0;
					const ptr_end = 4 * scanline_width;
					const rgbeStart = new Uint8Array( 4 );
					const scanline_buffer = new Uint8Array( ptr_end );
					let num_scanlines = h; // read in each successive scanline

					while ( num_scanlines > 0 && pos < buffer.byteLength ) {

						if ( pos + 4 > buffer.byteLength ) {

							return rgbe_error( rgbe_read_error );

						}

						rgbeStart[ 0 ] = buffer[ pos ++ ];
						rgbeStart[ 1 ] = buffer[ pos ++ ];
						rgbeStart[ 2 ] = buffer[ pos ++ ];
						rgbeStart[ 3 ] = buffer[ pos ++ ];

						if ( 2 != rgbeStart[ 0 ] || 2 != rgbeStart[ 1 ] || ( rgbeStart[ 2 ] << 8 | rgbeStart[ 3 ] ) != scanline_width ) {

							return rgbe_error( rgbe_format_error, 'bad rgbe scanline format' );

						} // read each of the four channels for the scanline into the buffer
						// first red, then green, then blue, then exponent


						let ptr = 0,
							count;

						while ( ptr < ptr_end && pos < buffer.byteLength ) {

							count = buffer[ pos ++ ];
							const isEncodedRun = count > 128;
							if ( isEncodedRun ) count -= 128;

							if ( 0 === count || ptr + count > ptr_end ) {

								return rgbe_error( rgbe_format_error, 'bad scanline data' );

							}

							if ( isEncodedRun ) {

								// a (encoded) run of the same value
								const byteValue = buffer[ pos ++ ];

								for ( let i = 0; i < count; i ++ ) {

									scanline_buffer[ ptr ++ ] = byteValue;

								} //ptr += count;

							} else {

								// a literal-run
								scanline_buffer.set( buffer.subarray( pos, pos + count ), ptr );
								ptr += count;
								pos += count;

							}

						} // now convert data from buffer into rgba
						// first red, then green, then blue, then exponent (alpha)


						const l = scanline_width; //scanline_buffer.byteLength;

						for ( let i = 0; i < l; i ++ ) {

							let off = 0;
							data_rgba[ offset ] = scanline_buffer[ i + off ];
							off += scanline_width; //1;

							data_rgba[ offset + 1 ] = scanline_buffer[ i + off ];
							off += scanline_width; //1;

							data_rgba[ offset + 2 ] = scanline_buffer[ i + off ];
							off += scanline_width; //1;

							data_rgba[ offset + 3 ] = scanline_buffer[ i + off ];
							offset += 4;

						}

						num_scanlines --;

					}

					return data_rgba;

				};

			const RGBEByteToRGBFloat = function ( sourceArray, sourceOffset, destArray, destOffset ) {

				const e = sourceArray[ sourceOffset + 3 ];
				const scale = Math.pow( 2.0, e - 128.0 ) / 255.0;
				destArray[ destOffset + 0 ] = sourceArray[ sourceOffset + 0 ] * scale;
				destArray[ destOffset + 1 ] = sourceArray[ sourceOffset + 1 ] * scale;
				destArray[ destOffset + 2 ] = sourceArray[ sourceOffset + 2 ] * scale;

			};

			const RGBEByteToRGBHalf = function ( sourceArray, sourceOffset, destArray, destOffset ) {

				const e = sourceArray[ sourceOffset + 3 ];
				const scale = Math.pow( 2.0, e - 128.0 ) / 255.0;
				destArray[ destOffset + 0 ] = THREE.DataUtils.toHalfFloat( sourceArray[ sourceOffset + 0 ] * scale );
				destArray[ destOffset + 1 ] = THREE.DataUtils.toHalfFloat( sourceArray[ sourceOffset + 1 ] * scale );
				destArray[ destOffset + 2 ] = THREE.DataUtils.toHalfFloat( sourceArray[ sourceOffset + 2 ] * scale );

			};

			const byteArray = new Uint8Array( buffer );
			byteArray.pos = 0;
			const rgbe_header_info = RGBE_ReadHeader( byteArray );

			if ( RGBE_RETURN_FAILURE !== rgbe_header_info ) {

				const w = rgbe_header_info.width,
					h = rgbe_header_info.height,
					image_rgba_data = RGBE_ReadPixels_RLE( byteArray.subarray( byteArray.pos ), w, h );

				if ( RGBE_RETURN_FAILURE !== image_rgba_data ) {

					let data, format, type;
					let numElements;

					switch ( this.type ) {

						case THREE.UnsignedByteType:
							data = image_rgba_data;
							format = THREE.RGBEFormat; // handled as THREE.RGBAFormat in shaders

							type = THREE.UnsignedByteType;
							break;

						case THREE.FloatType:
							numElements = image_rgba_data.length / 4 * 3;
							const floatArray = new Float32Array( numElements );

							for ( let j = 0; j < numElements; j ++ ) {

								RGBEByteToRGBFloat( image_rgba_data, j * 4, floatArray, j * 3 );

							}

							data = floatArray;
							format = THREE.RGBFormat;
							type = THREE.FloatType;
							break;

						case THREE.HalfFloatType:
							numElements = image_rgba_data.length / 4 * 3;
							const halfArray = new Uint16Array( numElements );

							for ( let j = 0; j < numElements; j ++ ) {

								RGBEByteToRGBHalf( image_rgba_data, j * 4, halfArray, j * 3 );

							}

							data = halfArray;
							format = THREE.RGBFormat;
							type = THREE.HalfFloatType;
							break;

						default:
							console.error( 'THREE.RGBELoader: unsupported type: ', this.type );
							break;

					}

					return {
						width: w,
						height: h,
						data: data,
						header: rgbe_header_info.string,
						gamma: rgbe_header_info.gamma,
						exposure: rgbe_header_info.exposure,
						format: format,
						type: type
					};

				}

			}

			return null;

		}

		setDataType( value ) {

			this.type = value;
			return this;

		}

		load( url, onLoad, onProgress, onError ) {

			function onLoadCallback( texture, texData ) {

				switch ( texture.type ) {

					case THREE.UnsignedByteType:
						texture.encoding = THREE.RGBEEncoding;
						texture.minFilter = THREE.NearestFilter;
						texture.magFilter = THREE.NearestFilter;
						texture.generateMipmaps = false;
						texture.flipY = true;
						break;

					case THREE.FloatType:
						texture.encoding = THREE.LinearEncoding;
						texture.minFilter = THREE.LinearFilter;
						texture.magFilter = THREE.LinearFilter;
						texture.generateMipmaps = false;
						texture.flipY = true;
						break;

					case THREE.HalfFloatType:
						texture.encoding = THREE.LinearEncoding;
						texture.minFilter = THREE.LinearFilter;
						texture.magFilter = THREE.LinearFilter;
						texture.generateMipmaps = false;
						texture.flipY = true;
						break;

				}

				if ( onLoad ) onLoad( texture, texData );

			}

			return super.load( url, onLoadCallback, onProgress, onError );

		}

	}

	THREE.RGBELoader = RGBELoader;

} )();

/* --- three/examples/js/exporters/GLTFExporter.js --- */
( function () {

	class GLTFExporter {

		constructor() {

			this.pluginCallbacks = [];
			this.register( function ( writer ) {

				return new GLTFLightExtension( writer );

			} );
			this.register( function ( writer ) {

				return new GLTFMaterialsUnlitExtension( writer );

			} );
			this.register( function ( writer ) {

				return new GLTFMaterialsPBRSpecularGlossiness( writer );

			} );

		}

		register( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) === - 1 ) {

				this.pluginCallbacks.push( callback );

			}

			return this;

		}

		unregister( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) !== - 1 ) {

				this.pluginCallbacks.splice( this.pluginCallbacks.indexOf( callback ), 1 );

			}

			return this;

		}
		/**
   * Parse scenes and generate GLTF output
   * @param  {Scene or [THREE.Scenes]} input   THREE.Scene or Array of THREE.Scenes
   * @param  {Function} onDone  Callback on completed
   * @param  {Object} options options
   */


		parse( input, onDone, options ) {

			const writer = new GLTFWriter();
			const plugins = [];

			for ( let i = 0, il = this.pluginCallbacks.length; i < il; i ++ ) {

				plugins.push( this.pluginCallbacks[ i ]( writer ) );

			}

			writer.setPlugins( plugins );
			writer.write( input, onDone, options );

		}

	} //------------------------------------------------------------------------------
	// Constants
	//------------------------------------------------------------------------------


	const WEBGL_CONSTANTS = {
		POINTS: 0x0000,
		LINES: 0x0001,
		LINE_LOOP: 0x0002,
		LINE_STRIP: 0x0003,
		TRIANGLES: 0x0004,
		TRIANGLE_STRIP: 0x0005,
		TRIANGLE_FAN: 0x0006,
		UNSIGNED_BYTE: 0x1401,
		UNSIGNED_SHORT: 0x1403,
		FLOAT: 0x1406,
		UNSIGNED_INT: 0x1405,
		ARRAY_BUFFER: 0x8892,
		ELEMENT_ARRAY_BUFFER: 0x8893,
		NEAREST: 0x2600,
		LINEAR: 0x2601,
		NEAREST_MIPMAP_NEAREST: 0x2700,
		LINEAR_MIPMAP_NEAREST: 0x2701,
		NEAREST_MIPMAP_LINEAR: 0x2702,
		LINEAR_MIPMAP_LINEAR: 0x2703,
		CLAMP_TO_EDGE: 33071,
		MIRRORED_REPEAT: 33648,
		REPEAT: 10497
	};
	const THREE_TO_WEBGL = {};
	THREE_TO_WEBGL[ THREE.NearestFilter ] = WEBGL_CONSTANTS.NEAREST;
	THREE_TO_WEBGL[ THREE.NearestMipmapNearestFilter ] = WEBGL_CONSTANTS.NEAREST_MIPMAP_NEAREST;
	THREE_TO_WEBGL[ THREE.NearestMipmapLinearFilter ] = WEBGL_CONSTANTS.NEAREST_MIPMAP_LINEAR;
	THREE_TO_WEBGL[ THREE.LinearFilter ] = WEBGL_CONSTANTS.LINEAR;
	THREE_TO_WEBGL[ THREE.LinearMipmapNearestFilter ] = WEBGL_CONSTANTS.LINEAR_MIPMAP_NEAREST;
	THREE_TO_WEBGL[ THREE.LinearMipmapLinearFilter ] = WEBGL_CONSTANTS.LINEAR_MIPMAP_LINEAR;
	THREE_TO_WEBGL[ THREE.ClampToEdgeWrapping ] = WEBGL_CONSTANTS.CLAMP_TO_EDGE;
	THREE_TO_WEBGL[ THREE.RepeatWrapping ] = WEBGL_CONSTANTS.REPEAT;
	THREE_TO_WEBGL[ THREE.MirroredRepeatWrapping ] = WEBGL_CONSTANTS.MIRRORED_REPEAT;
	const PATH_PROPERTIES = {
		scale: 'scale',
		position: 'translation',
		quaternion: 'rotation',
		morphTargetInfluences: 'weights'
	}; // GLB constants
	// https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#glb-file-format-specification

	const GLB_HEADER_BYTES = 12;
	const GLB_HEADER_MAGIC = 0x46546C67;
	const GLB_VERSION = 2;
	const GLB_CHUNK_PREFIX_BYTES = 8;
	const GLB_CHUNK_TYPE_JSON = 0x4E4F534A;
	const GLB_CHUNK_TYPE_BIN = 0x004E4942; //------------------------------------------------------------------------------
	// Utility functions
	//------------------------------------------------------------------------------

	/**
 * Compare two arrays
 * @param  {Array} array1 Array 1 to compare
 * @param  {Array} array2 Array 2 to compare
 * @return {Boolean}        Returns true if both arrays are equal
 */

	function equalArray( array1, array2 ) {

		return array1.length === array2.length && array1.every( function ( element, index ) {

			return element === array2[ index ];

		} );

	}
	/**
 * Converts a string to an ArrayBuffer.
 * @param  {string} text
 * @return {ArrayBuffer}
 */


	function stringToArrayBuffer( text ) {

		if ( window.TextEncoder !== undefined ) {

			return new TextEncoder().encode( text ).buffer;

		}

		const array = new Uint8Array( new ArrayBuffer( text.length ) );

		for ( let i = 0, il = text.length; i < il; i ++ ) {

			const value = text.charCodeAt( i ); // Replacing multi-byte character with space(0x20).

			array[ i ] = value > 0xFF ? 0x20 : value;

		}

		return array.buffer;

	}
	/**
 * Is identity matrix
 *
 * @param {Matrix4} matrix
 * @returns {Boolean} Returns true, if parameter is identity matrix
 */


	function isIdentityMatrix( matrix ) {

		return equalArray( matrix.elements, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );

	}
	/**
 * Get the min and max vectors from the given attribute
 * @param  {BufferAttribute} attribute Attribute to find the min/max in range from start to start + count
 * @param  {Integer} start
 * @param  {Integer} count
 * @return {Object} Object containing the `min` and `max` values (As an array of attribute.itemSize components)
 */


	function getMinMax( attribute, start, count ) {

		const output = {
			min: new Array( attribute.itemSize ).fill( Number.POSITIVE_INFINITY ),
			max: new Array( attribute.itemSize ).fill( Number.NEGATIVE_INFINITY )
		};

		for ( let i = start; i < start + count; i ++ ) {

			for ( let a = 0; a < attribute.itemSize; a ++ ) {

				let value;

				if ( attribute.itemSize > 4 ) {

					// no support for interleaved data for itemSize > 4
					value = attribute.array[ i * attribute.itemSize + a ];

				} else {

					if ( a === 0 ) value = attribute.getX( i ); else if ( a === 1 ) value = attribute.getY( i ); else if ( a === 2 ) value = attribute.getZ( i ); else if ( a === 3 ) value = attribute.getW( i );

				}

				output.min[ a ] = Math.min( output.min[ a ], value );
				output.max[ a ] = Math.max( output.max[ a ], value );

			}

		}

		return output;

	}
	/**
 * Get the required size + padding for a buffer, rounded to the next 4-byte boundary.
 * https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#data-alignment
 *
 * @param {Integer} bufferSize The size the original buffer.
 * @returns {Integer} new buffer size with required padding.
 *
 */


	function getPaddedBufferSize( bufferSize ) {

		return Math.ceil( bufferSize / 4 ) * 4;

	}
	/**
 * Returns a buffer aligned to 4-byte boundary.
 *
 * @param {ArrayBuffer} arrayBuffer Buffer to pad
 * @param {Integer} paddingByte (Optional)
 * @returns {ArrayBuffer} The same buffer if it's already aligned to 4-byte boundary or a new buffer
 */


	function getPaddedArrayBuffer( arrayBuffer, paddingByte = 0 ) {

		const paddedLength = getPaddedBufferSize( arrayBuffer.byteLength );

		if ( paddedLength !== arrayBuffer.byteLength ) {

			const array = new Uint8Array( paddedLength );
			array.set( new Uint8Array( arrayBuffer ) );

			if ( paddingByte !== 0 ) {

				for ( let i = arrayBuffer.byteLength; i < paddedLength; i ++ ) {

					array[ i ] = paddingByte;

				}

			}

			return array.buffer;

		}

		return arrayBuffer;

	}

	let cachedCanvas = null;
	/**
 * Writer
 */

	class GLTFWriter {

		constructor() {

			this.plugins = [];
			this.options = {};
			this.pending = [];
			this.buffers = [];
			this.byteOffset = 0;
			this.buffers = [];
			this.nodeMap = new Map();
			this.skins = [];
			this.extensionsUsed = {};
			this.uids = new Map();
			this.uid = 0;
			this.json = {
				asset: {
					version: '2.0',
					generator: 'THREE.GLTFExporter'
				}
			};
			this.cache = {
				meshes: new Map(),
				attributes: new Map(),
				attributesNormalized: new Map(),
				materials: new Map(),
				textures: new Map(),
				images: new Map()
			};

		}

		setPlugins( plugins ) {

			this.plugins = plugins;

		}
		/**
   * Parse scenes and generate GLTF output
   * @param  {Scene or [THREE.Scenes]} input   THREE.Scene or Array of THREE.Scenes
   * @param  {Function} onDone  Callback on completed
   * @param  {Object} options options
   */


		write( input, onDone, options ) {

			this.options = Object.assign( {}, {
				// default options
				binary: false,
				trs: false,
				onlyVisible: true,
				truncateDrawRange: true,
				embedImages: true,
				maxTextureSize: Infinity,
				animations: [],
				includeCustomExtensions: false
			}, options );

			if ( this.options.animations.length > 0 ) {

				// Only TRS properties, and not matrices, may be targeted by animation.
				this.options.trs = true;

			}

			this.processInput( input );
			const writer = this;
			Promise.all( this.pending ).then( function () {

				const buffers = writer.buffers;
				const json = writer.json;
				const options = writer.options;
				const extensionsUsed = writer.extensionsUsed; // Merge buffers.

				const blob = new Blob( buffers, {
					type: 'application/octet-stream'
				} ); // Declare extensions.

				const extensionsUsedList = Object.keys( extensionsUsed );
				if ( extensionsUsedList.length > 0 ) json.extensionsUsed = extensionsUsedList; // Update bytelength of the single buffer.

				if ( json.buffers && json.buffers.length > 0 ) json.buffers[ 0 ].byteLength = blob.size;

				if ( options.binary === true ) {

					// https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#glb-file-format-specification
					const reader = new window.FileReader();
					reader.readAsArrayBuffer( blob );

					reader.onloadend = function () {

						// Binary chunk.
						const binaryChunk = getPaddedArrayBuffer( reader.result );
						const binaryChunkPrefix = new DataView( new ArrayBuffer( GLB_CHUNK_PREFIX_BYTES ) );
						binaryChunkPrefix.setUint32( 0, binaryChunk.byteLength, true );
						binaryChunkPrefix.setUint32( 4, GLB_CHUNK_TYPE_BIN, true ); // JSON chunk.

						const jsonChunk = getPaddedArrayBuffer( stringToArrayBuffer( JSON.stringify( json ) ), 0x20 );
						const jsonChunkPrefix = new DataView( new ArrayBuffer( GLB_CHUNK_PREFIX_BYTES ) );
						jsonChunkPrefix.setUint32( 0, jsonChunk.byteLength, true );
						jsonChunkPrefix.setUint32( 4, GLB_CHUNK_TYPE_JSON, true ); // GLB header.

						const header = new ArrayBuffer( GLB_HEADER_BYTES );
						const headerView = new DataView( header );
						headerView.setUint32( 0, GLB_HEADER_MAGIC, true );
						headerView.setUint32( 4, GLB_VERSION, true );
						const totalByteLength = GLB_HEADER_BYTES + jsonChunkPrefix.byteLength + jsonChunk.byteLength + binaryChunkPrefix.byteLength + binaryChunk.byteLength;
						headerView.setUint32( 8, totalByteLength, true );
						const glbBlob = new Blob( [ header, jsonChunkPrefix, jsonChunk, binaryChunkPrefix, binaryChunk ], {
							type: 'application/octet-stream'
						} );
						const glbReader = new window.FileReader();
						glbReader.readAsArrayBuffer( glbBlob );

						glbReader.onloadend = function () {

							onDone( glbReader.result );

						};

					};

				} else {

					if ( json.buffers && json.buffers.length > 0 ) {

						const reader = new window.FileReader();
						reader.readAsDataURL( blob );

						reader.onloadend = function () {

							const base64data = reader.result;
							json.buffers[ 0 ].uri = base64data;
							onDone( json );

						};

					} else {

						onDone( json );

					}

				}

			} );

		}
		/**
   * Serializes a userData.
   *
   * @param {THREE.Object3D|THREE.Material} object
   * @param {Object} objectDef
   */


		serializeUserData( object, objectDef ) {

			if ( Object.keys( object.userData ).length === 0 ) return;
			const options = this.options;
			const extensionsUsed = this.extensionsUsed;

			try {

				const json = JSON.parse( JSON.stringify( object.userData ) );

				if ( options.includeCustomExtensions && json.gltfExtensions ) {

					if ( objectDef.extensions === undefined ) objectDef.extensions = {};

					for ( const extensionName in json.gltfExtensions ) {

						objectDef.extensions[ extensionName ] = json.gltfExtensions[ extensionName ];
						extensionsUsed[ extensionName ] = true;

					}

					delete json.gltfExtensions;

				}

				if ( Object.keys( json ).length > 0 ) objectDef.extras = json;

			} catch ( error ) {

				console.warn( 'THREE.GLTFExporter: userData of \'' + object.name + '\' ' + 'won\'t be serialized because of JSON.stringify error - ' + error.message );

			}

		}
		/**
   * Assign and return a temporal unique id for an object
   * especially which doesn't have .uuid
   * @param  {Object} object
   * @return {Integer}
   */


		getUID( object ) {

			if ( ! this.uids.has( object ) ) this.uids.set( object, this.uid ++ );
			return this.uids.get( object );

		}
		/**
   * Checks if normal attribute values are normalized.
   *
   * @param {BufferAttribute} normal
   * @returns {Boolean}
   */


		isNormalizedNormalAttribute( normal ) {

			const cache = this.cache;
			if ( cache.attributesNormalized.has( normal ) ) return false;
			const v = new THREE.Vector3();

			for ( let i = 0, il = normal.count; i < il; i ++ ) {

				// 0.0005 is from glTF-validator
				if ( Math.abs( v.fromBufferAttribute( normal, i ).length() - 1.0 ) > 0.0005 ) return false;

			}

			return true;

		}
		/**
   * Creates normalized normal buffer attribute.
   *
   * @param {BufferAttribute} normal
   * @returns {BufferAttribute}
   *
   */


		createNormalizedNormalAttribute( normal ) {

			const cache = this.cache;
			if ( cache.attributesNormalized.has( normal ) ) return cache.attributesNormalized.get( normal );
			const attribute = normal.clone();
			const v = new THREE.Vector3();

			for ( let i = 0, il = attribute.count; i < il; i ++ ) {

				v.fromBufferAttribute( attribute, i );

				if ( v.x === 0 && v.y === 0 && v.z === 0 ) {

					// if values can't be normalized set (1, 0, 0)
					v.setX( 1.0 );

				} else {

					v.normalize();

				}

				attribute.setXYZ( i, v.x, v.y, v.z );

			}

			cache.attributesNormalized.set( normal, attribute );
			return attribute;

		}
		/**
   * Applies a texture transform, if present, to the map definition. Requires
   * the KHR_texture_transform extension.
   *
   * @param {Object} mapDef
   * @param {THREE.Texture} texture
   */


		applyTextureTransform( mapDef, texture ) {

			let didTransform = false;
			const transformDef = {};

			if ( texture.offset.x !== 0 || texture.offset.y !== 0 ) {

				transformDef.offset = texture.offset.toArray();
				didTransform = true;

			}

			if ( texture.rotation !== 0 ) {

				transformDef.rotation = texture.rotation;
				didTransform = true;

			}

			if ( texture.repeat.x !== 1 || texture.repeat.y !== 1 ) {

				transformDef.scale = texture.repeat.toArray();
				didTransform = true;

			}

			if ( didTransform ) {

				mapDef.extensions = mapDef.extensions || {};
				mapDef.extensions[ 'KHR_texture_transform' ] = transformDef;
				this.extensionsUsed[ 'KHR_texture_transform' ] = true;

			}

		}
		/**
   * Process a buffer to append to the default one.
   * @param  {ArrayBuffer} buffer
   * @return {Integer}
   */


		processBuffer( buffer ) {

			const json = this.json;
			const buffers = this.buffers;
			if ( ! json.buffers ) json.buffers = [ {
				byteLength: 0
			} ]; // All buffers are merged before export.

			buffers.push( buffer );
			return 0;

		}
		/**
   * Process and generate a BufferView
   * @param  {BufferAttribute} attribute
   * @param  {number} componentType
   * @param  {number} start
   * @param  {number} count
   * @param  {number} target (Optional) Target usage of the BufferView
   * @return {Object}
   */


		processBufferView( attribute, componentType, start, count, target ) {

			const json = this.json;
			if ( ! json.bufferViews ) json.bufferViews = []; // Create a new dataview and dump the attribute's array into it

			let componentSize;

			if ( componentType === WEBGL_CONSTANTS.UNSIGNED_BYTE ) {

				componentSize = 1;

			} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_SHORT ) {

				componentSize = 2;

			} else {

				componentSize = 4;

			}

			const byteLength = getPaddedBufferSize( count * attribute.itemSize * componentSize );
			const dataView = new DataView( new ArrayBuffer( byteLength ) );
			let offset = 0;

			for ( let i = start; i < start + count; i ++ ) {

				for ( let a = 0; a < attribute.itemSize; a ++ ) {

					let value;

					if ( attribute.itemSize > 4 ) {

						// no support for interleaved data for itemSize > 4
						value = attribute.array[ i * attribute.itemSize + a ];

					} else {

						if ( a === 0 ) value = attribute.getX( i ); else if ( a === 1 ) value = attribute.getY( i ); else if ( a === 2 ) value = attribute.getZ( i ); else if ( a === 3 ) value = attribute.getW( i );

					}

					if ( componentType === WEBGL_CONSTANTS.FLOAT ) {

						dataView.setFloat32( offset, value, true );

					} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_INT ) {

						dataView.setUint32( offset, value, true );

					} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_SHORT ) {

						dataView.setUint16( offset, value, true );

					} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_BYTE ) {

						dataView.setUint8( offset, value );

					}

					offset += componentSize;

				}

			}

			const bufferViewDef = {
				buffer: this.processBuffer( dataView.buffer ),
				byteOffset: this.byteOffset,
				byteLength: byteLength
			};
			if ( target !== undefined ) bufferViewDef.target = target;

			if ( target === WEBGL_CONSTANTS.ARRAY_BUFFER ) {

				// Only define byteStride for vertex attributes.
				bufferViewDef.byteStride = attribute.itemSize * componentSize;

			}

			this.byteOffset += byteLength;
			json.bufferViews.push( bufferViewDef ); // @TODO Merge bufferViews where possible.

			const output = {
				id: json.bufferViews.length - 1,
				byteLength: 0
			};
			return output;

		}
		/**
   * Process and generate a BufferView from an image Blob.
   * @param {Blob} blob
   * @return {Promise<Integer>}
   */


		processBufferViewImage( blob ) {

			const writer = this;
			const json = writer.json;
			if ( ! json.bufferViews ) json.bufferViews = [];
			return new Promise( function ( resolve ) {

				const reader = new window.FileReader();
				reader.readAsArrayBuffer( blob );

				reader.onloadend = function () {

					const buffer = getPaddedArrayBuffer( reader.result );
					const bufferViewDef = {
						buffer: writer.processBuffer( buffer ),
						byteOffset: writer.byteOffset,
						byteLength: buffer.byteLength
					};
					writer.byteOffset += buffer.byteLength;
					resolve( json.bufferViews.push( bufferViewDef ) - 1 );

				};

			} );

		}
		/**
   * Process attribute to generate an accessor
   * @param  {BufferAttribute} attribute Attribute to process
   * @param  {THREE.BufferGeometry} geometry (Optional) Geometry used for truncated draw range
   * @param  {Integer} start (Optional)
   * @param  {Integer} count (Optional)
   * @return {Integer|null} Index of the processed accessor on the "accessors" array
   */


		processAccessor( attribute, geometry, start, count ) {

			const options = this.options;
			const json = this.json;
			const types = {
				1: 'SCALAR',
				2: 'VEC2',
				3: 'VEC3',
				4: 'VEC4',
				16: 'MAT4'
			};
			let componentType; // Detect the component type of the attribute array (float, uint or ushort)

			if ( attribute.array.constructor === Float32Array ) {

				componentType = WEBGL_CONSTANTS.FLOAT;

			} else if ( attribute.array.constructor === Uint32Array ) {

				componentType = WEBGL_CONSTANTS.UNSIGNED_INT;

			} else if ( attribute.array.constructor === Uint16Array ) {

				componentType = WEBGL_CONSTANTS.UNSIGNED_SHORT;

			} else if ( attribute.array.constructor === Uint8Array ) {

				componentType = WEBGL_CONSTANTS.UNSIGNED_BYTE;

			} else {

				throw new Error( 'THREE.GLTFExporter: Unsupported bufferAttribute component type.' );

			}

			if ( start === undefined ) start = 0;
			if ( count === undefined ) count = attribute.count; // @TODO Indexed buffer geometry with drawRange not supported yet

			if ( options.truncateDrawRange && geometry !== undefined && geometry.index === null ) {

				const end = start + count;
				const end2 = geometry.drawRange.count === Infinity ? attribute.count : geometry.drawRange.start + geometry.drawRange.count;
				start = Math.max( start, geometry.drawRange.start );
				count = Math.min( end, end2 ) - start;
				if ( count < 0 ) count = 0;

			} // Skip creating an accessor if the attribute doesn't have data to export


			if ( count === 0 ) return null;
			const minMax = getMinMax( attribute, start, count );
			let bufferViewTarget; // If geometry isn't provided, don't infer the target usage of the bufferView. For
			// animation samplers, target must not be set.

			if ( geometry !== undefined ) {

				bufferViewTarget = attribute === geometry.index ? WEBGL_CONSTANTS.ELEMENT_ARRAY_BUFFER : WEBGL_CONSTANTS.ARRAY_BUFFER;

			}

			const bufferView = this.processBufferView( attribute, componentType, start, count, bufferViewTarget );
			const accessorDef = {
				bufferView: bufferView.id,
				byteOffset: bufferView.byteOffset,
				componentType: componentType,
				count: count,
				max: minMax.max,
				min: minMax.min,
				type: types[ attribute.itemSize ]
			};
			if ( attribute.normalized === true ) accessorDef.normalized = true;
			if ( ! json.accessors ) json.accessors = [];
			return json.accessors.push( accessorDef ) - 1;

		}
		/**
   * Process image
   * @param  {Image} image to process
   * @param  {Integer} format of the image (e.g. THREE.RGBFormat, THREE.RGBAFormat etc)
   * @param  {Boolean} flipY before writing out the image
   * @return {Integer}     Index of the processed texture in the "images" array
   */


		processImage( image, format, flipY ) {

			const writer = this;
			const cache = writer.cache;
			const json = writer.json;
			const options = writer.options;
			const pending = writer.pending;
			if ( ! cache.images.has( image ) ) cache.images.set( image, {} );
			const cachedImages = cache.images.get( image );
			const mimeType = format === THREE.RGBAFormat ? 'image/png' : 'image/jpeg';
			const key = mimeType + ':flipY/' + flipY.toString();
			if ( cachedImages[ key ] !== undefined ) return cachedImages[ key ];
			if ( ! json.images ) json.images = [];
			const imageDef = {
				mimeType: mimeType
			};

			if ( options.embedImages ) {

				const canvas = cachedCanvas = cachedCanvas || document.createElement( 'canvas' );
				canvas.width = Math.min( image.width, options.maxTextureSize );
				canvas.height = Math.min( image.height, options.maxTextureSize );
				const ctx = canvas.getContext( '2d' );

				if ( flipY === true ) {

					ctx.translate( 0, canvas.height );
					ctx.scale( 1, - 1 );

				}

				if ( typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement || typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement || typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas || typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap ) {

					ctx.drawImage( image, 0, 0, canvas.width, canvas.height );

				} else {

					if ( format !== THREE.RGBAFormat && format !== THREE.RGBFormat ) {

						console.error( 'GLTFExporter: Only RGB and RGBA formats are supported.' );

					}

					if ( image.width > options.maxTextureSize || image.height > options.maxTextureSize ) {

						console.warn( 'GLTFExporter: Image size is bigger than maxTextureSize', image );

					}

					let data = image.data;

					if ( format === THREE.RGBFormat ) {

						data = new Uint8ClampedArray( image.height * image.width * 4 );

						for ( let i = 0, j = 0; i < data.length; i += 4, j += 3 ) {

							data[ i + 0 ] = image.data[ j + 0 ];
							data[ i + 1 ] = image.data[ j + 1 ];
							data[ i + 2 ] = image.data[ j + 2 ];
							data[ i + 3 ] = 255;

						}

					}

					ctx.putImageData( new ImageData( data, image.width, image.height ), 0, 0 );

				}

				if ( options.binary === true ) {

					pending.push( new Promise( function ( resolve ) {

						canvas.toBlob( function ( blob ) {

							writer.processBufferViewImage( blob ).then( function ( bufferViewIndex ) {

								imageDef.bufferView = bufferViewIndex;
								resolve();

							} );

						}, mimeType );

					} ) );

				} else {

					imageDef.uri = canvas.toDataURL( mimeType );

				}

			} else {

				imageDef.uri = image.src;

			}

			const index = json.images.push( imageDef ) - 1;
			cachedImages[ key ] = index;
			return index;

		}
		/**
   * Process sampler
   * @param  {Texture} map Texture to process
   * @return {Integer}     Index of the processed texture in the "samplers" array
   */


		processSampler( map ) {

			const json = this.json;
			if ( ! json.samplers ) json.samplers = [];
			const samplerDef = {
				magFilter: THREE_TO_WEBGL[ map.magFilter ],
				minFilter: THREE_TO_WEBGL[ map.minFilter ],
				wrapS: THREE_TO_WEBGL[ map.wrapS ],
				wrapT: THREE_TO_WEBGL[ map.wrapT ]
			};
			return json.samplers.push( samplerDef ) - 1;

		}
		/**
   * Process texture
   * @param  {Texture} map Map to process
   * @return {Integer} Index of the processed texture in the "textures" array
   */


		processTexture( map ) {

			const cache = this.cache;
			const json = this.json;
			if ( cache.textures.has( map ) ) return cache.textures.get( map );
			if ( ! json.textures ) json.textures = [];
			const textureDef = {
				sampler: this.processSampler( map ),
				source: this.processImage( map.image, map.format, map.flipY )
			};
			if ( map.name ) textureDef.name = map.name;

			this._invokeAll( function ( ext ) {

				ext.writeTexture && ext.writeTexture( map, textureDef );

			} );

			const index = json.textures.push( textureDef ) - 1;
			cache.textures.set( map, index );
			return index;

		}
		/**
   * Process material
   * @param  {THREE.Material} material Material to process
   * @return {Integer|null} Index of the processed material in the "materials" array
   */


		processMaterial( material ) {

			const cache = this.cache;
			const json = this.json;
			if ( cache.materials.has( material ) ) return cache.materials.get( material );

			if ( material.isShaderMaterial ) {

				console.warn( 'GLTFExporter: THREE.ShaderMaterial not supported.' );
				return null;

			}

			if ( ! json.materials ) json.materials = []; // @QUESTION Should we avoid including any attribute that has the default value?

			const materialDef = {
				pbrMetallicRoughness: {}
			};

			if ( material.isMeshStandardMaterial !== true && material.isMeshBasicMaterial !== true ) {

				console.warn( 'GLTFExporter: Use MeshStandardMaterial or MeshBasicMaterial for best results.' );

			} // pbrMetallicRoughness.baseColorFactor


			const color = material.color.toArray().concat( [ material.opacity ] );

			if ( ! equalArray( color, [ 1, 1, 1, 1 ] ) ) {

				materialDef.pbrMetallicRoughness.baseColorFactor = color;

			}

			if ( material.isMeshStandardMaterial ) {

				materialDef.pbrMetallicRoughness.metallicFactor = material.metalness;
				materialDef.pbrMetallicRoughness.roughnessFactor = material.roughness;

			} else {

				materialDef.pbrMetallicRoughness.metallicFactor = 0.5;
				materialDef.pbrMetallicRoughness.roughnessFactor = 0.5;

			} // pbrMetallicRoughness.metallicRoughnessTexture


			if ( material.metalnessMap || material.roughnessMap ) {

				if ( material.metalnessMap === material.roughnessMap ) {

					const metalRoughMapDef = {
						index: this.processTexture( material.metalnessMap )
					};
					this.applyTextureTransform( metalRoughMapDef, material.metalnessMap );
					materialDef.pbrMetallicRoughness.metallicRoughnessTexture = metalRoughMapDef;

				} else {

					console.warn( 'THREE.GLTFExporter: Ignoring metalnessMap and roughnessMap because they are not the same Texture.' );

				}

			} // pbrMetallicRoughness.baseColorTexture or pbrSpecularGlossiness diffuseTexture


			if ( material.map ) {

				const baseColorMapDef = {
					index: this.processTexture( material.map )
				};
				this.applyTextureTransform( baseColorMapDef, material.map );
				materialDef.pbrMetallicRoughness.baseColorTexture = baseColorMapDef;

			}

			if ( material.emissive ) {

				// emissiveFactor
				const emissive = material.emissive.clone().multiplyScalar( material.emissiveIntensity ).toArray();

				if ( ! equalArray( emissive, [ 0, 0, 0 ] ) ) {

					materialDef.emissiveFactor = emissive;

				} // emissiveTexture


				if ( material.emissiveMap ) {

					const emissiveMapDef = {
						index: this.processTexture( material.emissiveMap )
					};
					this.applyTextureTransform( emissiveMapDef, material.emissiveMap );
					materialDef.emissiveTexture = emissiveMapDef;

				}

			} // normalTexture


			if ( material.normalMap ) {

				const normalMapDef = {
					index: this.processTexture( material.normalMap )
				};

				if ( material.normalScale && material.normalScale.x !== - 1 ) {

					if ( material.normalScale.x !== material.normalScale.y ) {

						console.warn( 'THREE.GLTFExporter: Normal scale components are different, ignoring Y and exporting X.' );

					}

					normalMapDef.scale = material.normalScale.x;

				}

				this.applyTextureTransform( normalMapDef, material.normalMap );
				materialDef.normalTexture = normalMapDef;

			} // occlusionTexture


			if ( material.aoMap ) {

				const occlusionMapDef = {
					index: this.processTexture( material.aoMap ),
					texCoord: 1
				};

				if ( material.aoMapIntensity !== 1.0 ) {

					occlusionMapDef.strength = material.aoMapIntensity;

				}

				this.applyTextureTransform( occlusionMapDef, material.aoMap );
				materialDef.occlusionTexture = occlusionMapDef;

			} // alphaMode


			if ( material.transparent ) {

				materialDef.alphaMode = 'BLEND';

			} else {

				if ( material.alphaTest > 0.0 ) {

					materialDef.alphaMode = 'MASK';
					materialDef.alphaCutoff = material.alphaTest;

				}

			} // doubleSided


			if ( material.side === THREE.DoubleSide ) materialDef.doubleSided = true;
			if ( material.name !== '' ) materialDef.name = material.name;
			this.serializeUserData( material, materialDef );

			this._invokeAll( function ( ext ) {

				ext.writeMaterial && ext.writeMaterial( material, materialDef );

			} );

			const index = json.materials.push( materialDef ) - 1;
			cache.materials.set( material, index );
			return index;

		}
		/**
   * Process mesh
   * @param  {THREE.Mesh} mesh Mesh to process
   * @return {Integer|null} Index of the processed mesh in the "meshes" array
   */


		processMesh( mesh ) {

			const cache = this.cache;
			const json = this.json;
			const meshCacheKeyParts = [ mesh.geometry.uuid ];

			if ( Array.isArray( mesh.material ) ) {

				for ( let i = 0, l = mesh.material.length; i < l; i ++ ) {

					meshCacheKeyParts.push( mesh.material[ i ].uuid );

				}

			} else {

				meshCacheKeyParts.push( mesh.material.uuid );

			}

			const meshCacheKey = meshCacheKeyParts.join( ':' );
			if ( cache.meshes.has( meshCacheKey ) ) return cache.meshes.get( meshCacheKey );
			const geometry = mesh.geometry;
			let mode; // Use the correct mode

			if ( mesh.isLineSegments ) {

				mode = WEBGL_CONSTANTS.LINES;

			} else if ( mesh.isLineLoop ) {

				mode = WEBGL_CONSTANTS.LINE_LOOP;

			} else if ( mesh.isLine ) {

				mode = WEBGL_CONSTANTS.LINE_STRIP;

			} else if ( mesh.isPoints ) {

				mode = WEBGL_CONSTANTS.POINTS;

			} else {

				mode = mesh.material.wireframe ? WEBGL_CONSTANTS.LINES : WEBGL_CONSTANTS.TRIANGLES;

			}

			if ( geometry.isBufferGeometry !== true ) {

				throw new Error( 'THREE.GLTFExporter: Geometry is not of type THREE.BufferGeometry.' );

			}

			const meshDef = {};
			const attributes = {};
			const primitives = [];
			const targets = []; // Conversion between attributes names in threejs and gltf spec

			const nameConversion = {
				uv: 'TEXCOORD_0',
				uv2: 'TEXCOORD_1',
				color: 'COLOR_0',
				skinWeight: 'WEIGHTS_0',
				skinIndex: 'JOINTS_0'
			};
			const originalNormal = geometry.getAttribute( 'normal' );

			if ( originalNormal !== undefined && ! this.isNormalizedNormalAttribute( originalNormal ) ) {

				console.warn( 'THREE.GLTFExporter: Creating normalized normal attribute from the non-normalized one.' );
				geometry.setAttribute( 'normal', this.createNormalizedNormalAttribute( originalNormal ) );

			} // @QUESTION Detect if .vertexColors = true?
			// For every attribute create an accessor


			let modifiedAttribute = null;

			for ( let attributeName in geometry.attributes ) {

				// Ignore morph target attributes, which are exported later.
				if ( attributeName.substr( 0, 5 ) === 'morph' ) continue;
				const attribute = geometry.attributes[ attributeName ];
				attributeName = nameConversion[ attributeName ] || attributeName.toUpperCase(); // Prefix all geometry attributes except the ones specifically
				// listed in the spec; non-spec attributes are considered custom.

				const validVertexAttributes = /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+|JOINTS_\d+|WEIGHTS_\d+)$/;
				if ( ! validVertexAttributes.test( attributeName ) ) attributeName = '_' + attributeName;

				if ( cache.attributes.has( this.getUID( attribute ) ) ) {

					attributes[ attributeName ] = cache.attributes.get( this.getUID( attribute ) );
					continue;

				} // JOINTS_0 must be UNSIGNED_BYTE or UNSIGNED_SHORT.


				modifiedAttribute = null;
				const array = attribute.array;

				if ( attributeName === 'JOINTS_0' && ! ( array instanceof Uint16Array ) && ! ( array instanceof Uint8Array ) ) {

					console.warn( 'GLTFExporter: Attribute "skinIndex" converted to type UNSIGNED_SHORT.' );
					modifiedAttribute = new THREE.BufferAttribute( new Uint16Array( array ), attribute.itemSize, attribute.normalized );

				}

				const accessor = this.processAccessor( modifiedAttribute || attribute, geometry );

				if ( accessor !== null ) {

					attributes[ attributeName ] = accessor;
					cache.attributes.set( this.getUID( attribute ), accessor );

				}

			}

			if ( originalNormal !== undefined ) geometry.setAttribute( 'normal', originalNormal ); // Skip if no exportable attributes found

			if ( Object.keys( attributes ).length === 0 ) return null; // Morph targets

			if ( mesh.morphTargetInfluences !== undefined && mesh.morphTargetInfluences.length > 0 ) {

				const weights = [];
				const targetNames = [];
				const reverseDictionary = {};

				if ( mesh.morphTargetDictionary !== undefined ) {

					for ( const key in mesh.morphTargetDictionary ) {

						reverseDictionary[ mesh.morphTargetDictionary[ key ] ] = key;

					}

				}

				for ( let i = 0; i < mesh.morphTargetInfluences.length; ++ i ) {

					const target = {};
					let warned = false;

					for ( const attributeName in geometry.morphAttributes ) {

						// glTF 2.0 morph supports only POSITION/NORMAL/TANGENT.
						// Three.js doesn't support TANGENT yet.
						if ( attributeName !== 'position' && attributeName !== 'normal' ) {

							if ( ! warned ) {

								console.warn( 'GLTFExporter: Only POSITION and NORMAL morph are supported.' );
								warned = true;

							}

							continue;

						}

						const attribute = geometry.morphAttributes[ attributeName ][ i ];
						const gltfAttributeName = attributeName.toUpperCase(); // Three.js morph attribute has absolute values while the one of glTF has relative values.
						//
						// glTF 2.0 Specification:
						// https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#morph-targets

						const baseAttribute = geometry.attributes[ attributeName ];

						if ( cache.attributes.has( this.getUID( attribute ) ) ) {

							target[ gltfAttributeName ] = cache.attributes.get( this.getUID( attribute ) );
							continue;

						} // Clones attribute not to override


						const relativeAttribute = attribute.clone();

						if ( ! geometry.morphTargetsRelative ) {

							for ( let j = 0, jl = attribute.count; j < jl; j ++ ) {

								relativeAttribute.setXYZ( j, attribute.getX( j ) - baseAttribute.getX( j ), attribute.getY( j ) - baseAttribute.getY( j ), attribute.getZ( j ) - baseAttribute.getZ( j ) );

							}

						}

						target[ gltfAttributeName ] = this.processAccessor( relativeAttribute, geometry );
						cache.attributes.set( this.getUID( baseAttribute ), target[ gltfAttributeName ] );

					}

					targets.push( target );
					weights.push( mesh.morphTargetInfluences[ i ] );
					if ( mesh.morphTargetDictionary !== undefined ) targetNames.push( reverseDictionary[ i ] );

				}

				meshDef.weights = weights;

				if ( targetNames.length > 0 ) {

					meshDef.extras = {};
					meshDef.extras.targetNames = targetNames;

				}

			}

			const isMultiMaterial = Array.isArray( mesh.material );
			if ( isMultiMaterial && geometry.groups.length === 0 ) return null;
			const materials = isMultiMaterial ? mesh.material : [ mesh.material ];
			const groups = isMultiMaterial ? geometry.groups : [ {
				materialIndex: 0,
				start: undefined,
				count: undefined
			} ];

			for ( let i = 0, il = groups.length; i < il; i ++ ) {

				const primitive = {
					mode: mode,
					attributes: attributes
				};
				this.serializeUserData( geometry, primitive );
				if ( targets.length > 0 ) primitive.targets = targets;

				if ( geometry.index !== null ) {

					let cacheKey = this.getUID( geometry.index );

					if ( groups[ i ].start !== undefined || groups[ i ].count !== undefined ) {

						cacheKey += ':' + groups[ i ].start + ':' + groups[ i ].count;

					}

					if ( cache.attributes.has( cacheKey ) ) {

						primitive.indices = cache.attributes.get( cacheKey );

					} else {

						primitive.indices = this.processAccessor( geometry.index, geometry, groups[ i ].start, groups[ i ].count );
						cache.attributes.set( cacheKey, primitive.indices );

					}

					if ( primitive.indices === null ) delete primitive.indices;

				}

				const material = this.processMaterial( materials[ groups[ i ].materialIndex ] );
				if ( material !== null ) primitive.material = material;
				primitives.push( primitive );

			}

			meshDef.primitives = primitives;
			if ( ! json.meshes ) json.meshes = [];

			this._invokeAll( function ( ext ) {

				ext.writeMesh && ext.writeMesh( mesh, meshDef );

			} );

			const index = json.meshes.push( meshDef ) - 1;
			cache.meshes.set( meshCacheKey, index );
			return index;

		}
		/**
   * Process camera
   * @param  {THREE.Camera} camera Camera to process
   * @return {Integer}      Index of the processed mesh in the "camera" array
   */


		processCamera( camera ) {

			const json = this.json;
			if ( ! json.cameras ) json.cameras = [];
			const isOrtho = camera.isOrthographicCamera;
			const cameraDef = {
				type: isOrtho ? 'orthographic' : 'perspective'
			};

			if ( isOrtho ) {

				cameraDef.orthographic = {
					xmag: camera.right * 2,
					ymag: camera.top * 2,
					zfar: camera.far <= 0 ? 0.001 : camera.far,
					znear: camera.near < 0 ? 0 : camera.near
				};

			} else {

				cameraDef.perspective = {
					aspectRatio: camera.aspect,
					yfov: THREE.MathUtils.degToRad( camera.fov ),
					zfar: camera.far <= 0 ? 0.001 : camera.far,
					znear: camera.near < 0 ? 0 : camera.near
				};

			} // Question: Is saving "type" as name intentional?


			if ( camera.name !== '' ) cameraDef.name = camera.type;
			return json.cameras.push( cameraDef ) - 1;

		}
		/**
   * Creates glTF animation entry from AnimationClip object.
   *
   * Status:
   * - Only properties listed in PATH_PROPERTIES may be animated.
   *
   * @param {THREE.AnimationClip} clip
   * @param {THREE.Object3D} root
   * @return {number|null}
   */


		processAnimation( clip, root ) {

			const json = this.json;
			const nodeMap = this.nodeMap;
			if ( ! json.animations ) json.animations = [];
			clip = GLTFExporter.Utils.mergeMorphTargetTracks( clip.clone(), root );
			const tracks = clip.tracks;
			const channels = [];
			const samplers = [];

			for ( let i = 0; i < tracks.length; ++ i ) {

				const track = tracks[ i ];
				const trackBinding = THREE.PropertyBinding.parseTrackName( track.name );
				let trackNode = THREE.PropertyBinding.findNode( root, trackBinding.nodeName );
				const trackProperty = PATH_PROPERTIES[ trackBinding.propertyName ];

				if ( trackBinding.objectName === 'bones' ) {

					if ( trackNode.isSkinnedMesh === true ) {

						trackNode = trackNode.skeleton.getBoneByName( trackBinding.objectIndex );

					} else {

						trackNode = undefined;

					}

				}

				if ( ! trackNode || ! trackProperty ) {

					console.warn( 'THREE.GLTFExporter: Could not export animation track "%s".', track.name );
					return null;

				}

				const inputItemSize = 1;
				let outputItemSize = track.values.length / track.times.length;

				if ( trackProperty === PATH_PROPERTIES.morphTargetInfluences ) {

					outputItemSize /= trackNode.morphTargetInfluences.length;

				}

				let interpolation; // @TODO export CubicInterpolant(InterpolateSmooth) as CUBICSPLINE
				// Detecting glTF cubic spline interpolant by checking factory method's special property
				// GLTFCubicSplineInterpolant is a custom interpolant and track doesn't return
				// valid value from .getInterpolation().

				if ( track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline === true ) {

					interpolation = 'CUBICSPLINE'; // itemSize of CUBICSPLINE keyframe is 9
					// (VEC3 * 3: inTangent, splineVertex, and outTangent)
					// but needs to be stored as VEC3 so dividing by 3 here.

					outputItemSize /= 3;

				} else if ( track.getInterpolation() === THREE.InterpolateDiscrete ) {

					interpolation = 'STEP';

				} else {

					interpolation = 'LINEAR';

				}

				samplers.push( {
					input: this.processAccessor( new THREE.BufferAttribute( track.times, inputItemSize ) ),
					output: this.processAccessor( new THREE.BufferAttribute( track.values, outputItemSize ) ),
					interpolation: interpolation
				} );
				channels.push( {
					sampler: samplers.length - 1,
					target: {
						node: nodeMap.get( trackNode ),
						path: trackProperty
					}
				} );

			}

			json.animations.push( {
				name: clip.name || 'clip_' + json.animations.length,
				samplers: samplers,
				channels: channels
			} );
			return json.animations.length - 1;

		}
		/**
   * @param {THREE.Object3D} object
   * @return {number|null}
   */


		processSkin( object ) {

			const json = this.json;
			const nodeMap = this.nodeMap;
			const node = json.nodes[ nodeMap.get( object ) ];
			const skeleton = object.skeleton;
			if ( skeleton === undefined ) return null;
			const rootJoint = object.skeleton.bones[ 0 ];
			if ( rootJoint === undefined ) return null;
			const joints = [];
			const inverseBindMatrices = new Float32Array( skeleton.bones.length * 16 );
			const temporaryBoneInverse = new THREE.Matrix4();

			for ( let i = 0; i < skeleton.bones.length; ++ i ) {

				joints.push( nodeMap.get( skeleton.bones[ i ] ) );
				temporaryBoneInverse.copy( skeleton.boneInverses[ i ] );
				temporaryBoneInverse.multiply( object.bindMatrix ).toArray( inverseBindMatrices, i * 16 );

			}

			if ( json.skins === undefined ) json.skins = [];
			json.skins.push( {
				inverseBindMatrices: this.processAccessor( new THREE.BufferAttribute( inverseBindMatrices, 16 ) ),
				joints: joints,
				skeleton: nodeMap.get( rootJoint )
			} );
			const skinIndex = node.skin = json.skins.length - 1;
			return skinIndex;

		}
		/**
   * Process Object3D node
   * @param  {THREE.Object3D} node Object3D to processNode
   * @return {Integer} Index of the node in the nodes list
   */


		processNode( object ) {

			const json = this.json;
			const options = this.options;
			const nodeMap = this.nodeMap;
			if ( ! json.nodes ) json.nodes = [];
			const nodeDef = {};

			if ( options.trs ) {

				const rotation = object.quaternion.toArray();
				const position = object.position.toArray();
				const scale = object.scale.toArray();

				if ( ! equalArray( rotation, [ 0, 0, 0, 1 ] ) ) {

					nodeDef.rotation = rotation;

				}

				if ( ! equalArray( position, [ 0, 0, 0 ] ) ) {

					nodeDef.translation = position;

				}

				if ( ! equalArray( scale, [ 1, 1, 1 ] ) ) {

					nodeDef.scale = scale;

				}

			} else {

				if ( object.matrixAutoUpdate ) {

					object.updateMatrix();

				}

				if ( isIdentityMatrix( object.matrix ) === false ) {

					nodeDef.matrix = object.matrix.elements;

				}

			} // We don't export empty strings name because it represents no-name in Three.js.


			if ( object.name !== '' ) nodeDef.name = String( object.name );
			this.serializeUserData( object, nodeDef );

			if ( object.isMesh || object.isLine || object.isPoints ) {

				const meshIndex = this.processMesh( object );
				if ( meshIndex !== null ) nodeDef.mesh = meshIndex;

			} else if ( object.isCamera ) {

				nodeDef.camera = this.processCamera( object );

			}

			if ( object.isSkinnedMesh ) this.skins.push( object );

			if ( object.children.length > 0 ) {

				const children = [];

				for ( let i = 0, l = object.children.length; i < l; i ++ ) {

					const child = object.children[ i ];

					if ( child.visible || options.onlyVisible === false ) {

						const nodeIndex = this.processNode( child );
						if ( nodeIndex !== null ) children.push( nodeIndex );

					}

				}

				if ( children.length > 0 ) nodeDef.children = children;

			}

			this._invokeAll( function ( ext ) {

				ext.writeNode && ext.writeNode( object, nodeDef );

			} );

			const nodeIndex = json.nodes.push( nodeDef ) - 1;
			nodeMap.set( object, nodeIndex );
			return nodeIndex;

		}
		/**
   * Process THREE.Scene
   * @param  {Scene} node THREE.Scene to process
   */


		processScene( scene ) {

			const json = this.json;
			const options = this.options;

			if ( ! json.scenes ) {

				json.scenes = [];
				json.scene = 0;

			}

			const sceneDef = {};
			if ( scene.name !== '' ) sceneDef.name = scene.name;
			json.scenes.push( sceneDef );
			const nodes = [];

			for ( let i = 0, l = scene.children.length; i < l; i ++ ) {

				const child = scene.children[ i ];

				if ( child.visible || options.onlyVisible === false ) {

					const nodeIndex = this.processNode( child );
					if ( nodeIndex !== null ) nodes.push( nodeIndex );

				}

			}

			if ( nodes.length > 0 ) sceneDef.nodes = nodes;
			this.serializeUserData( scene, sceneDef );

		}
		/**
   * Creates a THREE.Scene to hold a list of objects and parse it
   * @param  {Array} objects List of objects to process
   */


		processObjects( objects ) {

			const scene = new THREE.Scene();
			scene.name = 'AuxScene';

			for ( let i = 0; i < objects.length; i ++ ) {

				// We push directly to children instead of calling `add` to prevent
				// modify the .parent and break its original scene and hierarchy
				scene.children.push( objects[ i ] );

			}

			this.processScene( scene );

		}
		/**
   * @param {THREE.Object3D|Array<THREE.Object3D>} input
   */


		processInput( input ) {

			const options = this.options;
			input = input instanceof Array ? input : [ input ];

			this._invokeAll( function ( ext ) {

				ext.beforeParse && ext.beforeParse( input );

			} );

			const objectsWithoutScene = [];

			for ( let i = 0; i < input.length; i ++ ) {

				if ( input[ i ] instanceof THREE.Scene ) {

					this.processScene( input[ i ] );

				} else {

					objectsWithoutScene.push( input[ i ] );

				}

			}

			if ( objectsWithoutScene.length > 0 ) this.processObjects( objectsWithoutScene );

			for ( let i = 0; i < this.skins.length; ++ i ) {

				this.processSkin( this.skins[ i ] );

			}

			for ( let i = 0; i < options.animations.length; ++ i ) {

				this.processAnimation( options.animations[ i ], input[ 0 ] );

			}

			this._invokeAll( function ( ext ) {

				ext.afterParse && ext.afterParse( input );

			} );

		}

		_invokeAll( func ) {

			for ( let i = 0, il = this.plugins.length; i < il; i ++ ) {

				func( this.plugins[ i ] );

			}

		}

	}
	/**
 * Punctual Lights Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_lights_punctual
 */


	class GLTFLightExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_lights_punctual';

		}

		writeNode( light, nodeDef ) {

			if ( ! light.isLight ) return;

			if ( ! light.isDirectionalLight && ! light.isPointLight && ! light.isSpotLight ) {

				console.warn( 'THREE.GLTFExporter: Only directional, point, and spot lights are supported.', light );
				return;

			}

			const writer = this.writer;
			const json = writer.json;
			const extensionsUsed = writer.extensionsUsed;
			const lightDef = {};
			if ( light.name ) lightDef.name = light.name;
			lightDef.color = light.color.toArray();
			lightDef.intensity = light.intensity;

			if ( light.isDirectionalLight ) {

				lightDef.type = 'directional';

			} else if ( light.isPointLight ) {

				lightDef.type = 'point';
				if ( light.distance > 0 ) lightDef.range = light.distance;

			} else if ( light.isSpotLight ) {

				lightDef.type = 'spot';
				if ( light.distance > 0 ) lightDef.range = light.distance;
				lightDef.spot = {};
				lightDef.spot.innerConeAngle = ( light.penumbra - 1.0 ) * light.angle * - 1.0;
				lightDef.spot.outerConeAngle = light.angle;

			}

			if ( light.decay !== undefined && light.decay !== 2 ) {

				console.warn( 'THREE.GLTFExporter: Light decay may be lost. glTF is physically-based, ' + 'and expects light.decay=2.' );

			}

			if ( light.target && ( light.target.parent !== light || light.target.position.x !== 0 || light.target.position.y !== 0 || light.target.position.z !== - 1 ) ) {

				console.warn( 'THREE.GLTFExporter: Light direction may be lost. For best results, ' + 'make light.target a child of the light with position 0,0,-1.' );

			}

			if ( ! extensionsUsed[ this.name ] ) {

				json.extensions = json.extensions || {};
				json.extensions[ this.name ] = {
					lights: []
				};
				extensionsUsed[ this.name ] = true;

			}

			const lights = json.extensions[ this.name ].lights;
			lights.push( lightDef );
			nodeDef.extensions = nodeDef.extensions || {};
			nodeDef.extensions[ this.name ] = {
				light: lights.length - 1
			};

		}

	}
	/**
 * Unlit Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_unlit
 */


	class GLTFMaterialsUnlitExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_materials_unlit';

		}

		writeMaterial( material, materialDef ) {

			if ( ! material.isMeshBasicMaterial ) return;
			const writer = this.writer;
			const extensionsUsed = writer.extensionsUsed;
			materialDef.extensions = materialDef.extensions || {};
			materialDef.extensions[ this.name ] = {};
			extensionsUsed[ this.name ] = true;
			materialDef.pbrMetallicRoughness.metallicFactor = 0.0;
			materialDef.pbrMetallicRoughness.roughnessFactor = 0.9;

		}

	}
	/**
 * Specular-Glossiness Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_pbrSpecularGlossiness
 */


	class GLTFMaterialsPBRSpecularGlossiness {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_materials_pbrSpecularGlossiness';

		}

		writeMaterial( material, materialDef ) {

			if ( ! material.isGLTFSpecularGlossinessMaterial ) return;
			const writer = this.writer;
			const extensionsUsed = writer.extensionsUsed;
			const extensionDef = {};

			if ( materialDef.pbrMetallicRoughness.baseColorFactor ) {

				extensionDef.diffuseFactor = materialDef.pbrMetallicRoughness.baseColorFactor;

			}

			const specularFactor = [ 1, 1, 1 ];
			material.specular.toArray( specularFactor, 0 );
			extensionDef.specularFactor = specularFactor;
			extensionDef.glossinessFactor = material.glossiness;

			if ( materialDef.pbrMetallicRoughness.baseColorTexture ) {

				extensionDef.diffuseTexture = materialDef.pbrMetallicRoughness.baseColorTexture;

			}

			if ( material.specularMap ) {

				const specularMapDef = {
					index: writer.processTexture( material.specularMap )
				};
				writer.applyTextureTransform( specularMapDef, material.specularMap );
				extensionDef.specularGlossinessTexture = specularMapDef;

			}

			materialDef.extensions = materialDef.extensions || {};
			materialDef.extensions[ this.name ] = extensionDef;
			extensionsUsed[ this.name ] = true;

		}

	}
	/**
 * Static utility functions
 */


	GLTFExporter.Utils = {
		insertKeyframe: function ( track, time ) {

			const tolerance = 0.001; // 1ms

			const valueSize = track.getValueSize();
			const times = new track.TimeBufferType( track.times.length + 1 );
			const values = new track.ValueBufferType( track.values.length + valueSize );
			const interpolant = track.createInterpolant( new track.ValueBufferType( valueSize ) );
			let index;

			if ( track.times.length === 0 ) {

				times[ 0 ] = time;

				for ( let i = 0; i < valueSize; i ++ ) {

					values[ i ] = 0;

				}

				index = 0;

			} else if ( time < track.times[ 0 ] ) {

				if ( Math.abs( track.times[ 0 ] - time ) < tolerance ) return 0;
				times[ 0 ] = time;
				times.set( track.times, 1 );
				values.set( interpolant.evaluate( time ), 0 );
				values.set( track.values, valueSize );
				index = 0;

			} else if ( time > track.times[ track.times.length - 1 ] ) {

				if ( Math.abs( track.times[ track.times.length - 1 ] - time ) < tolerance ) {

					return track.times.length - 1;

				}

				times[ times.length - 1 ] = time;
				times.set( track.times, 0 );
				values.set( track.values, 0 );
				values.set( interpolant.evaluate( time ), track.values.length );
				index = times.length - 1;

			} else {

				for ( let i = 0; i < track.times.length; i ++ ) {

					if ( Math.abs( track.times[ i ] - time ) < tolerance ) return i;

					if ( track.times[ i ] < time && track.times[ i + 1 ] > time ) {

						times.set( track.times.slice( 0, i + 1 ), 0 );
						times[ i + 1 ] = time;
						times.set( track.times.slice( i + 1 ), i + 2 );
						values.set( track.values.slice( 0, ( i + 1 ) * valueSize ), 0 );
						values.set( interpolant.evaluate( time ), ( i + 1 ) * valueSize );
						values.set( track.values.slice( ( i + 1 ) * valueSize ), ( i + 2 ) * valueSize );
						index = i + 1;
						break;

					}

				}

			}

			track.times = times;
			track.values = values;
			return index;

		},
		mergeMorphTargetTracks: function ( clip, root ) {

			const tracks = [];
			const mergedTracks = {};
			const sourceTracks = clip.tracks;

			for ( let i = 0; i < sourceTracks.length; ++ i ) {

				let sourceTrack = sourceTracks[ i ];
				const sourceTrackBinding = THREE.PropertyBinding.parseTrackName( sourceTrack.name );
				const sourceTrackNode = THREE.PropertyBinding.findNode( root, sourceTrackBinding.nodeName );

				if ( sourceTrackBinding.propertyName !== 'morphTargetInfluences' || sourceTrackBinding.propertyIndex === undefined ) {

					// Tracks that don't affect morph targets, or that affect all morph targets together, can be left as-is.
					tracks.push( sourceTrack );
					continue;

				}

				if ( sourceTrack.createInterpolant !== sourceTrack.InterpolantFactoryMethodDiscrete && sourceTrack.createInterpolant !== sourceTrack.InterpolantFactoryMethodLinear ) {

					if ( sourceTrack.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline ) {

						// This should never happen, because glTF morph target animations
						// affect all targets already.
						throw new Error( 'THREE.GLTFExporter: Cannot merge tracks with glTF CUBICSPLINE interpolation.' );

					}

					console.warn( 'THREE.GLTFExporter: Morph target interpolation mode not yet supported. Using LINEAR instead.' );
					sourceTrack = sourceTrack.clone();
					sourceTrack.setInterpolation( THREE.InterpolateLinear );

				}

				const targetCount = sourceTrackNode.morphTargetInfluences.length;
				const targetIndex = sourceTrackNode.morphTargetDictionary[ sourceTrackBinding.propertyIndex ];

				if ( targetIndex === undefined ) {

					throw new Error( 'THREE.GLTFExporter: Morph target name not found: ' + sourceTrackBinding.propertyIndex );

				}

				let mergedTrack; // If this is the first time we've seen this object, create a new
				// track to store merged keyframe data for each morph target.

				if ( mergedTracks[ sourceTrackNode.uuid ] === undefined ) {

					mergedTrack = sourceTrack.clone();
					const values = new mergedTrack.ValueBufferType( targetCount * mergedTrack.times.length );

					for ( let j = 0; j < mergedTrack.times.length; j ++ ) {

						values[ j * targetCount + targetIndex ] = mergedTrack.values[ j ];

					} // We need to take into consideration the intended target node
					// of our original un-merged morphTarget animation.


					mergedTrack.name = ( sourceTrackBinding.nodeName || '' ) + '.morphTargetInfluences';
					mergedTrack.values = values;
					mergedTracks[ sourceTrackNode.uuid ] = mergedTrack;
					tracks.push( mergedTrack );
					continue;

				}

				const sourceInterpolant = sourceTrack.createInterpolant( new sourceTrack.ValueBufferType( 1 ) );
				mergedTrack = mergedTracks[ sourceTrackNode.uuid ]; // For every existing keyframe of the merged track, write a (possibly
				// interpolated) value from the source track.

				for ( let j = 0; j < mergedTrack.times.length; j ++ ) {

					mergedTrack.values[ j * targetCount + targetIndex ] = sourceInterpolant.evaluate( mergedTrack.times[ j ] );

				} // For every existing keyframe of the source track, write a (possibly
				// new) keyframe to the merged track. Values from the previous loop may
				// be written again, but keyframes are de-duplicated.


				for ( let j = 0; j < sourceTrack.times.length; j ++ ) {

					const keyframeIndex = this.insertKeyframe( mergedTrack, sourceTrack.times[ j ] );
					mergedTrack.values[ keyframeIndex * targetCount + targetIndex ] = sourceTrack.values[ j ];

				}

			}

			clip.tracks = tracks;
			return clip;

		}
	};

	THREE.GLTFExporter = GLTFExporter;

} )();

/* --- three/examples/js/misc/GPUComputationRenderer.js --- */
( function () {

	/**
 * GPUComputationRenderer, based on SimulationRenderer by zz85
 *
 * The GPUComputationRenderer uses the concept of variables. These variables are RGBA float textures that hold 4 floats
 * for each compute element (texel)
 *
 * Each variable has a fragment shader that defines the computation made to obtain the variable in question.
 * You can use as many variables you need, and make dependencies so you can use textures of other variables in the shader
 * (the sampler uniforms are added automatically) Most of the variables will need themselves as dependency.
 *
 * The renderer has actually two render targets per variable, to make ping-pong. Textures from the current frame are used
 * as inputs to render the textures of the next frame.
 *
 * The render targets of the variables can be used as input textures for your visualization shaders.
 *
 * Variable names should be valid identifiers and should not collide with THREE GLSL used identifiers.
 * a common approach could be to use 'texture' prefixing the variable name; i.e texturePosition, textureVelocity...
 *
 * The size of the computation (sizeX * sizeY) is defined as 'resolution' automatically in the shader. For example:
 * #DEFINE resolution vec2( 1024.0, 1024.0 )
 *
 * -------------
 *
 * Basic use:
 *
 * // Initialization...
 *
 * // Create computation renderer
 * const gpuCompute = new GPUComputationRenderer( 1024, 1024, renderer );
 *
 * // Create initial state float textures
 * const pos0 = gpuCompute.createTexture();
 * const vel0 = gpuCompute.createTexture();
 * // and fill in here the texture data...
 *
 * // Add texture variables
 * const velVar = gpuCompute.addVariable( "textureVelocity", fragmentShaderVel, pos0 );
 * const posVar = gpuCompute.addVariable( "texturePosition", fragmentShaderPos, vel0 );
 *
 * // Add variable dependencies
 * gpuCompute.setVariableDependencies( velVar, [ velVar, posVar ] );
 * gpuCompute.setVariableDependencies( posVar, [ velVar, posVar ] );
 *
 * // Add custom uniforms
 * velVar.material.uniforms.time = { value: 0.0 };
 *
 * // Check for completeness
 * const error = gpuCompute.init();
 * if ( error !== null ) {
 *		console.error( error );
  * }
 *
 *
 * // In each frame...
 *
 * // Compute!
 * gpuCompute.compute();
 *
 * // Update texture uniforms in your visualization materials with the gpu renderer output
 * myMaterial.uniforms.myTexture.value = gpuCompute.getCurrentRenderTarget( posVar ).texture;
 *
 * // Do your rendering
 * renderer.render( myScene, myCamera );
 *
 * -------------
 *
 * Also, you can use utility functions to create THREE.ShaderMaterial and perform computations (rendering between textures)
 * Note that the shaders can have multiple input textures.
 *
 * const myFilter1 = gpuCompute.createShaderMaterial( myFilterFragmentShader1, { theTexture: { value: null } } );
 * const myFilter2 = gpuCompute.createShaderMaterial( myFilterFragmentShader2, { theTexture: { value: null } } );
 *
 * const inputTexture = gpuCompute.createTexture();
 *
 * // Fill in here inputTexture...
 *
 * myFilter1.uniforms.theTexture.value = inputTexture;
 *
 * const myRenderTarget = gpuCompute.createRenderTarget();
 * myFilter2.uniforms.theTexture.value = myRenderTarget.texture;
 *
 * const outputRenderTarget = gpuCompute.createRenderTarget();
 *
 * // Now use the output texture where you want:
 * myMaterial.uniforms.map.value = outputRenderTarget.texture;
 *
 * // And compute each frame, before rendering to screen:
 * gpuCompute.doRenderTarget( myFilter1, myRenderTarget );
 * gpuCompute.doRenderTarget( myFilter2, outputRenderTarget );
 *
 *
 *
 * @param {int} sizeX Computation problem size is always 2d: sizeX * sizeY elements.
 * @param {int} sizeY Computation problem size is always 2d: sizeX * sizeY elements.
 * @param {WebGLRenderer} renderer The renderer
  */

	class GPUComputationRenderer {

		constructor( sizeX, sizeY, renderer ) {

			this.variables = [];
			this.currentTextureIndex = 0;
			let dataType = THREE.FloatType;
			const scene = new THREE.Scene();
			const camera = new THREE.Camera();
			camera.position.z = 1;
			const passThruUniforms = {
				passThruTexture: {
					value: null
				}
			};
			const passThruShader = createShaderMaterial( getPassThroughFragmentShader(), passThruUniforms );
			const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), passThruShader );
			scene.add( mesh );

			this.setDataType = function ( type ) {

				dataType = type;
				return this;

			};

			this.addVariable = function ( variableName, computeFragmentShader, initialValueTexture ) {

				const material = this.createShaderMaterial( computeFragmentShader );
				const variable = {
					name: variableName,
					initialValueTexture: initialValueTexture,
					material: material,
					dependencies: null,
					renderTargets: [],
					wrapS: null,
					wrapT: null,
					minFilter: THREE.NearestFilter,
					magFilter: THREE.NearestFilter
				};
				this.variables.push( variable );
				return variable;

			};

			this.setVariableDependencies = function ( variable, dependencies ) {

				variable.dependencies = dependencies;

			};

			this.init = function () {

				if ( renderer.capabilities.isWebGL2 === false && renderer.extensions.has( 'OES_texture_float' ) === false ) {

					return 'No OES_texture_float support for float textures.';

				}

				if ( renderer.capabilities.maxVertexTextures === 0 ) {

					return 'No support for vertex shader textures.';

				}

				for ( let i = 0; i < this.variables.length; i ++ ) {

					const variable = this.variables[ i ]; // Creates rendertargets and initialize them with input texture

					variable.renderTargets[ 0 ] = this.createRenderTarget( sizeX, sizeY, variable.wrapS, variable.wrapT, variable.minFilter, variable.magFilter );
					variable.renderTargets[ 1 ] = this.createRenderTarget( sizeX, sizeY, variable.wrapS, variable.wrapT, variable.minFilter, variable.magFilter );
					this.renderTexture( variable.initialValueTexture, variable.renderTargets[ 0 ] );
					this.renderTexture( variable.initialValueTexture, variable.renderTargets[ 1 ] ); // Adds dependencies uniforms to the THREE.ShaderMaterial

					const material = variable.material;
					const uniforms = material.uniforms;

					if ( variable.dependencies !== null ) {

						for ( let d = 0; d < variable.dependencies.length; d ++ ) {

							const depVar = variable.dependencies[ d ];

							if ( depVar.name !== variable.name ) {

								// Checks if variable exists
								let found = false;

								for ( let j = 0; j < this.variables.length; j ++ ) {

									if ( depVar.name === this.variables[ j ].name ) {

										found = true;
										break;

									}

								}

								if ( ! found ) {

									return 'Variable dependency not found. Variable=' + variable.name + ', dependency=' + depVar.name;

								}

							}

							uniforms[ depVar.name ] = {
								value: null
							};
							material.fragmentShader = '\nuniform sampler2D ' + depVar.name + ';\n' + material.fragmentShader;

						}

					}

				}

				this.currentTextureIndex = 0;
				return null;

			};

			this.compute = function () {

				const currentTextureIndex = this.currentTextureIndex;
				const nextTextureIndex = this.currentTextureIndex === 0 ? 1 : 0;

				for ( let i = 0, il = this.variables.length; i < il; i ++ ) {

					const variable = this.variables[ i ]; // Sets texture dependencies uniforms

					if ( variable.dependencies !== null ) {

						const uniforms = variable.material.uniforms;

						for ( let d = 0, dl = variable.dependencies.length; d < dl; d ++ ) {

							const depVar = variable.dependencies[ d ];
							uniforms[ depVar.name ].value = depVar.renderTargets[ currentTextureIndex ].texture;

						}

					} // Performs the computation for this variable


					this.doRenderTarget( variable.material, variable.renderTargets[ nextTextureIndex ] );

				}

				this.currentTextureIndex = nextTextureIndex;

			};

			this.getCurrentRenderTarget = function ( variable ) {

				return variable.renderTargets[ this.currentTextureIndex ];

			};

			this.getAlternateRenderTarget = function ( variable ) {

				return variable.renderTargets[ this.currentTextureIndex === 0 ? 1 : 0 ];

			};

			function addResolutionDefine( materialShader ) {

				materialShader.defines.resolution = 'vec2( ' + sizeX.toFixed( 1 ) + ', ' + sizeY.toFixed( 1 ) + ' )';

			}

			this.addResolutionDefine = addResolutionDefine; // The following functions can be used to compute things manually

			function createShaderMaterial( computeFragmentShader, uniforms ) {

				uniforms = uniforms || {};
				const material = new THREE.ShaderMaterial( {
					uniforms: uniforms,
					vertexShader: getPassThroughVertexShader(),
					fragmentShader: computeFragmentShader
				} );
				addResolutionDefine( material );
				return material;

			}

			this.createShaderMaterial = createShaderMaterial;

			this.createRenderTarget = function ( sizeXTexture, sizeYTexture, wrapS, wrapT, minFilter, magFilter ) {

				sizeXTexture = sizeXTexture || sizeX;
				sizeYTexture = sizeYTexture || sizeY;
				wrapS = wrapS || THREE.ClampToEdgeWrapping;
				wrapT = wrapT || THREE.ClampToEdgeWrapping;
				minFilter = minFilter || THREE.NearestFilter;
				magFilter = magFilter || THREE.NearestFilter;
				const renderTarget = new THREE.WebGLRenderTarget( sizeXTexture, sizeYTexture, {
					wrapS: wrapS,
					wrapT: wrapT,
					minFilter: minFilter,
					magFilter: magFilter,
					format: THREE.RGBAFormat,
					type: dataType,
					depthBuffer: false
				} );
				return renderTarget;

			};

			this.createTexture = function () {

				const data = new Float32Array( sizeX * sizeY * 4 );
				return new THREE.DataTexture( data, sizeX, sizeY, THREE.RGBAFormat, THREE.FloatType );

			};

			this.renderTexture = function ( input, output ) {

				// Takes a texture, and render out in rendertarget
				// input = Texture
				// output = RenderTarget
				passThruUniforms.passThruTexture.value = input;
				this.doRenderTarget( passThruShader, output );
				passThruUniforms.passThruTexture.value = null;

			};

			this.doRenderTarget = function ( material, output ) {

				const currentRenderTarget = renderer.getRenderTarget();
				mesh.material = material;
				renderer.setRenderTarget( output );
				renderer.render( scene, camera );
				mesh.material = passThruShader;
				renderer.setRenderTarget( currentRenderTarget );

			}; // Shaders


			function getPassThroughVertexShader() {

				return 'void main()	{\n' + '\n' + '	gl_Position = vec4( position, 1.0 );\n' + '\n' + '}\n';

			}

			function getPassThroughFragmentShader() {

				return 'uniform sampler2D passThruTexture;\n' + '\n' + 'void main() {\n' + '\n' + '	vec2 uv = gl_FragCoord.xy / resolution.xy;\n' + '\n' + '	gl_FragColor = texture2D( passThruTexture, uv );\n' + '\n' + '}\n';

			}

		}

	}

	THREE.GPUComputationRenderer = GPUComputationRenderer;

} )();

/* --- three/examples/js/misc/ConvexObjectBreaker.js --- */
( function () {

	/**
 * @fileoverview This class can be used to subdivide a convex Geometry object into pieces.
 *
 * Usage:
 *
 * Use the function prepareBreakableObject to prepare a THREE.Mesh object to be broken.
 *
 * Then, call the various functions to subdivide the object (subdivideByImpact, cutByPlane)
 *
 * Sub-objects that are product of subdivision don't need prepareBreakableObject to be called on them.
 *
 * Requisites for the object:
 *
 *  - THREE.Mesh object must have a BufferGeometry (not Geometry) and a Material
 *
 *  - Vertex normals must be planar (not smoothed)
 *
 *  - The geometry must be convex (this is not checked in the library). You can create convex
 *  geometries with THREE.ConvexGeometry. The BoxGeometry, SphereGeometry and other convex primitives
 *  can also be used.
 *
 * Note: This lib adds member variables to object's userData member (see prepareBreakableObject function)
 * Use with caution and read the code when using with other libs.
 *
 * @param {double} minSizeForBreak Min size a debris can have to break.
 * @param {double} smallDelta Max distance to consider that a point belongs to a plane.
 *
*/

	const _v1 = new THREE.Vector3();

	class ConvexObjectBreaker {

		constructor( minSizeForBreak = 1.4, smallDelta = 0.0001 ) {

			this.minSizeForBreak = minSizeForBreak;
			this.smallDelta = smallDelta;
			this.tempLine1 = new THREE.Line3();
			this.tempPlane1 = new THREE.Plane();
			this.tempPlane2 = new THREE.Plane();
			this.tempPlane_Cut = new THREE.Plane();
			this.tempCM1 = new THREE.Vector3();
			this.tempCM2 = new THREE.Vector3();
			this.tempVector3 = new THREE.Vector3();
			this.tempVector3_2 = new THREE.Vector3();
			this.tempVector3_3 = new THREE.Vector3();
			this.tempVector3_P0 = new THREE.Vector3();
			this.tempVector3_P1 = new THREE.Vector3();
			this.tempVector3_P2 = new THREE.Vector3();
			this.tempVector3_N0 = new THREE.Vector3();
			this.tempVector3_N1 = new THREE.Vector3();
			this.tempVector3_AB = new THREE.Vector3();
			this.tempVector3_CB = new THREE.Vector3();
			this.tempResultObjects = {
				object1: null,
				object2: null
			};
			this.segments = [];
			const n = 30 * 30;

			for ( let i = 0; i < n; i ++ ) this.segments[ i ] = false;

		}

		prepareBreakableObject( object, mass, velocity, angularVelocity, breakable ) {

			// object is a Object3d (normally a THREE.Mesh), must have a BufferGeometry, and it must be convex.
			// Its material property is propagated to its children (sub-pieces)
			// mass must be > 0
			if ( ! object.geometry.isBufferGeometry ) {

				console.error( 'THREE.ConvexObjectBreaker.prepareBreakableObject(): Parameter object must have a BufferGeometry.' );

			}

			const userData = object.userData;
			userData.mass = mass;
			userData.velocity = velocity.clone();
			userData.angularVelocity = angularVelocity.clone();
			userData.breakable = breakable;

		}
		/*
   * @param {int} maxRadialIterations Iterations for radial cuts.
   * @param {int} maxRandomIterations Max random iterations for not-radial cuts
   *
   * Returns the array of pieces
   */


		subdivideByImpact( object, pointOfImpact, normal, maxRadialIterations, maxRandomIterations ) {

			const debris = [];
			const tempPlane1 = this.tempPlane1;
			const tempPlane2 = this.tempPlane2;
			this.tempVector3.addVectors( pointOfImpact, normal );
			tempPlane1.setFromCoplanarPoints( pointOfImpact, object.position, this.tempVector3 );
			const maxTotalIterations = maxRandomIterations + maxRadialIterations;
			const scope = this;

			function subdivideRadial( subObject, startAngle, endAngle, numIterations ) {

				if ( Math.random() < numIterations * 0.05 || numIterations > maxTotalIterations ) {

					debris.push( subObject );
					return;

				}

				let angle = Math.PI;

				if ( numIterations === 0 ) {

					tempPlane2.normal.copy( tempPlane1.normal );
					tempPlane2.constant = tempPlane1.constant;

				} else {

					if ( numIterations <= maxRadialIterations ) {

						angle = ( endAngle - startAngle ) * ( 0.2 + 0.6 * Math.random() ) + startAngle; // Rotate tempPlane2 at impact point around normal axis and the angle

						scope.tempVector3_2.copy( object.position ).sub( pointOfImpact ).applyAxisAngle( normal, angle ).add( pointOfImpact );
						tempPlane2.setFromCoplanarPoints( pointOfImpact, scope.tempVector3, scope.tempVector3_2 );

					} else {

						angle = ( 0.5 * ( numIterations & 1 ) + 0.2 * ( 2 - Math.random() ) ) * Math.PI; // Rotate tempPlane2 at object position around normal axis and the angle

						scope.tempVector3_2.copy( pointOfImpact ).sub( subObject.position ).applyAxisAngle( normal, angle ).add( subObject.position );
						scope.tempVector3_3.copy( normal ).add( subObject.position );
						tempPlane2.setFromCoplanarPoints( subObject.position, scope.tempVector3_3, scope.tempVector3_2 );

					}

				} // Perform the cut


				scope.cutByPlane( subObject, tempPlane2, scope.tempResultObjects );
				const obj1 = scope.tempResultObjects.object1;
				const obj2 = scope.tempResultObjects.object2;

				if ( obj1 ) {

					subdivideRadial( obj1, startAngle, angle, numIterations + 1 );

				}

				if ( obj2 ) {

					subdivideRadial( obj2, angle, endAngle, numIterations + 1 );

				}

			}

			subdivideRadial( object, 0, 2 * Math.PI, 0 );
			return debris;

		}

		cutByPlane( object, plane, output ) {

			// Returns breakable objects in output.object1 and output.object2 members, the resulting 2 pieces of the cut.
			// object2 can be null if the plane doesn't cut the object.
			// object1 can be null only in case of internal error
			// Returned value is number of pieces, 0 for error.
			const geometry = object.geometry;
			const coords = geometry.attributes.position.array;
			const normals = geometry.attributes.normal.array;
			const numPoints = coords.length / 3;
			let numFaces = numPoints / 3;
			let indices = geometry.getIndex();

			if ( indices ) {

				indices = indices.array;
				numFaces = indices.length / 3;

			}

			function getVertexIndex( faceIdx, vert ) {

				// vert = 0, 1 or 2.
				const idx = faceIdx * 3 + vert;
				return indices ? indices[ idx ] : idx;

			}

			const points1 = [];
			const points2 = [];
			const delta = this.smallDelta; // Reset segments mark

			const numPointPairs = numPoints * numPoints;

			for ( let i = 0; i < numPointPairs; i ++ ) this.segments[ i ] = false;

			const p0 = this.tempVector3_P0;
			const p1 = this.tempVector3_P1;
			const n0 = this.tempVector3_N0;
			const n1 = this.tempVector3_N1; // Iterate through the faces to mark edges shared by coplanar faces

			for ( let i = 0; i < numFaces - 1; i ++ ) {

				const a1 = getVertexIndex( i, 0 );
				const b1 = getVertexIndex( i, 1 );
				const c1 = getVertexIndex( i, 2 ); // Assuming all 3 vertices have the same normal

				n0.set( normals[ a1 ], normals[ a1 ] + 1, normals[ a1 ] + 2 );

				for ( let j = i + 1; j < numFaces; j ++ ) {

					const a2 = getVertexIndex( j, 0 );
					const b2 = getVertexIndex( j, 1 );
					const c2 = getVertexIndex( j, 2 ); // Assuming all 3 vertices have the same normal

					n1.set( normals[ a2 ], normals[ a2 ] + 1, normals[ a2 ] + 2 );
					const coplanar = 1 - n0.dot( n1 ) < delta;

					if ( coplanar ) {

						if ( a1 === a2 || a1 === b2 || a1 === c2 ) {

							if ( b1 === a2 || b1 === b2 || b1 === c2 ) {

								this.segments[ a1 * numPoints + b1 ] = true;
								this.segments[ b1 * numPoints + a1 ] = true;

							} else {

								this.segments[ c1 * numPoints + a1 ] = true;
								this.segments[ a1 * numPoints + c1 ] = true;

							}

						} else if ( b1 === a2 || b1 === b2 || b1 === c2 ) {

							this.segments[ c1 * numPoints + b1 ] = true;
							this.segments[ b1 * numPoints + c1 ] = true;

						}

					}

				}

			} // Transform the plane to object local space


			const localPlane = this.tempPlane_Cut;
			object.updateMatrix();
			ConvexObjectBreaker.transformPlaneToLocalSpace( plane, object.matrix, localPlane ); // Iterate through the faces adding points to both pieces

			for ( let i = 0; i < numFaces; i ++ ) {

				const va = getVertexIndex( i, 0 );
				const vb = getVertexIndex( i, 1 );
				const vc = getVertexIndex( i, 2 );

				for ( let segment = 0; segment < 3; segment ++ ) {

					const i0 = segment === 0 ? va : segment === 1 ? vb : vc;
					const i1 = segment === 0 ? vb : segment === 1 ? vc : va;
					const segmentState = this.segments[ i0 * numPoints + i1 ];
					if ( segmentState ) continue; // The segment already has been processed in another face
					// Mark segment as processed (also inverted segment)

					this.segments[ i0 * numPoints + i1 ] = true;
					this.segments[ i1 * numPoints + i0 ] = true;
					p0.set( coords[ 3 * i0 ], coords[ 3 * i0 + 1 ], coords[ 3 * i0 + 2 ] );
					p1.set( coords[ 3 * i1 ], coords[ 3 * i1 + 1 ], coords[ 3 * i1 + 2 ] ); // mark: 1 for negative side, 2 for positive side, 3 for coplanar point

					let mark0 = 0;
					let d = localPlane.distanceToPoint( p0 );

					if ( d > delta ) {

						mark0 = 2;
						points2.push( p0.clone() );

					} else if ( d < - delta ) {

						mark0 = 1;
						points1.push( p0.clone() );

					} else {

						mark0 = 3;
						points1.push( p0.clone() );
						points2.push( p0.clone() );

					} // mark: 1 for negative side, 2 for positive side, 3 for coplanar point


					let mark1 = 0;
					d = localPlane.distanceToPoint( p1 );

					if ( d > delta ) {

						mark1 = 2;
						points2.push( p1.clone() );

					} else if ( d < - delta ) {

						mark1 = 1;
						points1.push( p1.clone() );

					} else {

						mark1 = 3;
						points1.push( p1.clone() );
						points2.push( p1.clone() );

					}

					if ( mark0 === 1 && mark1 === 2 || mark0 === 2 && mark1 === 1 ) {

						// Intersection of segment with the plane
						this.tempLine1.start.copy( p0 );
						this.tempLine1.end.copy( p1 );
						let intersection = new THREE.Vector3();
						intersection = localPlane.intersectLine( this.tempLine1, intersection );

						if ( intersection === null ) {

							// Shouldn't happen
							console.error( 'Internal error: segment does not intersect plane.' );
							output.segmentedObject1 = null;
							output.segmentedObject2 = null;
							return 0;

						}

						points1.push( intersection );
						points2.push( intersection.clone() );

					}

				}

			} // Calculate debris mass (very fast and imprecise):


			const newMass = object.userData.mass * 0.5; // Calculate debris Center of Mass (again fast and imprecise)

			this.tempCM1.set( 0, 0, 0 );
			let radius1 = 0;
			const numPoints1 = points1.length;

			if ( numPoints1 > 0 ) {

				for ( let i = 0; i < numPoints1; i ++ ) this.tempCM1.add( points1[ i ] );

				this.tempCM1.divideScalar( numPoints1 );

				for ( let i = 0; i < numPoints1; i ++ ) {

					const p = points1[ i ];
					p.sub( this.tempCM1 );
					radius1 = Math.max( radius1, p.x, p.y, p.z );

				}

				this.tempCM1.add( object.position );

			}

			this.tempCM2.set( 0, 0, 0 );
			let radius2 = 0;
			const numPoints2 = points2.length;

			if ( numPoints2 > 0 ) {

				for ( let i = 0; i < numPoints2; i ++ ) this.tempCM2.add( points2[ i ] );

				this.tempCM2.divideScalar( numPoints2 );

				for ( let i = 0; i < numPoints2; i ++ ) {

					const p = points2[ i ];
					p.sub( this.tempCM2 );
					radius2 = Math.max( radius2, p.x, p.y, p.z );

				}

				this.tempCM2.add( object.position );

			}

			let object1 = null;
			let object2 = null;
			let numObjects = 0;

			if ( numPoints1 > 4 ) {

				object1 = new THREE.Mesh( new THREE.ConvexGeometry( points1 ), object.material );
				object1.position.copy( this.tempCM1 );
				object1.quaternion.copy( object.quaternion );
				this.prepareBreakableObject( object1, newMass, object.userData.velocity, object.userData.angularVelocity, 2 * radius1 > this.minSizeForBreak );
				numObjects ++;

			}

			if ( numPoints2 > 4 ) {

				object2 = new THREE.Mesh( new THREE.ConvexGeometry( points2 ), object.material );
				object2.position.copy( this.tempCM2 );
				object2.quaternion.copy( object.quaternion );
				this.prepareBreakableObject( object2, newMass, object.userData.velocity, object.userData.angularVelocity, 2 * radius2 > this.minSizeForBreak );
				numObjects ++;

			}

			output.object1 = object1;
			output.object2 = object2;
			return numObjects;

		}

		static transformFreeVector( v, m ) {

			// input:
			// vector interpreted as a free vector
			// THREE.Matrix4 orthogonal matrix (matrix without scale)
			const x = v.x,
				y = v.y,
				z = v.z;
			const e = m.elements;
			v.x = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z;
			v.y = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z;
			v.z = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z;
			return v;

		}

		static transformFreeVectorInverse( v, m ) {

			// input:
			// vector interpreted as a free vector
			// THREE.Matrix4 orthogonal matrix (matrix without scale)
			const x = v.x,
				y = v.y,
				z = v.z;
			const e = m.elements;
			v.x = e[ 0 ] * x + e[ 1 ] * y + e[ 2 ] * z;
			v.y = e[ 4 ] * x + e[ 5 ] * y + e[ 6 ] * z;
			v.z = e[ 8 ] * x + e[ 9 ] * y + e[ 10 ] * z;
			return v;

		}

		static transformTiedVectorInverse( v, m ) {

			// input:
			// vector interpreted as a tied (ordinary) vector
			// THREE.Matrix4 orthogonal matrix (matrix without scale)
			const x = v.x,
				y = v.y,
				z = v.z;
			const e = m.elements;
			v.x = e[ 0 ] * x + e[ 1 ] * y + e[ 2 ] * z - e[ 12 ];
			v.y = e[ 4 ] * x + e[ 5 ] * y + e[ 6 ] * z - e[ 13 ];
			v.z = e[ 8 ] * x + e[ 9 ] * y + e[ 10 ] * z - e[ 14 ];
			return v;

		}

		static transformPlaneToLocalSpace( plane, m, resultPlane ) {

			resultPlane.normal.copy( plane.normal );
			resultPlane.constant = plane.constant;
			const referencePoint = ConvexObjectBreaker.transformTiedVectorInverse( plane.coplanarPoint( _v1 ), m );
			ConvexObjectBreaker.transformFreeVectorInverse( resultPlane.normal, m ); // recalculate constant (like in setFromNormalAndCoplanarPoint)

			resultPlane.constant = - referencePoint.dot( resultPlane.normal );

		}

	}

	THREE.ConvexObjectBreaker = ConvexObjectBreaker;

} )();

/* --- three/examples/js/objects/Lensflare.js --- */
( function () {

	class Lensflare extends THREE.Mesh {

		constructor() {

			super( Lensflare.Geometry, new THREE.MeshBasicMaterial( {
				opacity: 0,
				transparent: true
			} ) );
			this.type = 'Lensflare';
			this.frustumCulled = false;
			this.renderOrder = Infinity; //

			const positionScreen = new THREE.Vector3();
			const positionView = new THREE.Vector3(); // textures

			const tempMap = new THREE.DataTexture( new Uint8Array( 16 * 16 * 3 ), 16, 16, THREE.RGBFormat );
			tempMap.minFilter = THREE.NearestFilter;
			tempMap.magFilter = THREE.NearestFilter;
			tempMap.wrapS = THREE.ClampToEdgeWrapping;
			tempMap.wrapT = THREE.ClampToEdgeWrapping;
			const occlusionMap = new THREE.DataTexture( new Uint8Array( 16 * 16 * 3 ), 16, 16, THREE.RGBFormat );
			occlusionMap.minFilter = THREE.NearestFilter;
			occlusionMap.magFilter = THREE.NearestFilter;
			occlusionMap.wrapS = THREE.ClampToEdgeWrapping;
			occlusionMap.wrapT = THREE.ClampToEdgeWrapping; // material

			const geometry = Lensflare.Geometry;
			const material1a = new THREE.RawShaderMaterial( {
				uniforms: {
					'scale': {
						value: null
					},
					'screenPosition': {
						value: null
					}
				},
				vertexShader:
      /* glsl */
      `

				precision highp float;

				uniform vec3 screenPosition;
				uniform vec2 scale;

				attribute vec3 position;

				void main() {

					gl_Position = vec4( position.xy * scale + screenPosition.xy, screenPosition.z, 1.0 );

				}`,
				fragmentShader:
      /* glsl */
      `

				precision highp float;

				void main() {

					gl_FragColor = vec4( 1.0, 0.0, 1.0, 1.0 );

				}`,
				depthTest: true,
				depthWrite: false,
				transparent: false
			} );
			const material1b = new THREE.RawShaderMaterial( {
				uniforms: {
					'map': {
						value: tempMap
					},
					'scale': {
						value: null
					},
					'screenPosition': {
						value: null
					}
				},
				vertexShader:
      /* glsl */
      `

				precision highp float;

				uniform vec3 screenPosition;
				uniform vec2 scale;

				attribute vec3 position;
				attribute vec2 uv;

				varying vec2 vUV;

				void main() {

					vUV = uv;

					gl_Position = vec4( position.xy * scale + screenPosition.xy, screenPosition.z, 1.0 );

				}`,
				fragmentShader:
      /* glsl */
      `

				precision highp float;

				uniform sampler2D map;

				varying vec2 vUV;

				void main() {

					gl_FragColor = texture2D( map, vUV );

				}`,
				depthTest: false,
				depthWrite: false,
				transparent: false
			} ); // the following object is used for occlusionMap generation

			const mesh1 = new THREE.Mesh( geometry, material1a ); //

			const elements = [];
			const shader = LensflareElement.Shader;
			const material2 = new THREE.RawShaderMaterial( {
				uniforms: {
					'map': {
						value: null
					},
					'occlusionMap': {
						value: occlusionMap
					},
					'color': {
						value: new THREE.Color( 0xffffff )
					},
					'scale': {
						value: new THREE.Vector2()
					},
					'screenPosition': {
						value: new THREE.Vector3()
					}
				},
				vertexShader: shader.vertexShader,
				fragmentShader: shader.fragmentShader,
				blending: THREE.AdditiveBlending,
				transparent: true,
				depthWrite: false
			} );
			const mesh2 = new THREE.Mesh( geometry, material2 );

			this.addElement = function ( element ) {

				elements.push( element );

			}; //


			const scale = new THREE.Vector2();
			const screenPositionPixels = new THREE.Vector2();
			const validArea = new THREE.Box2();
			const viewport = new THREE.Vector4();

			this.onBeforeRender = function ( renderer, scene, camera ) {

				renderer.getCurrentViewport( viewport );
				const invAspect = viewport.w / viewport.z;
				const halfViewportWidth = viewport.z / 2.0;
				const halfViewportHeight = viewport.w / 2.0;
				let size = 16 / viewport.w;
				scale.set( size * invAspect, size );
				validArea.min.set( viewport.x, viewport.y );
				validArea.max.set( viewport.x + ( viewport.z - 16 ), viewport.y + ( viewport.w - 16 ) ); // calculate position in screen space

				positionView.setFromMatrixPosition( this.matrixWorld );
				positionView.applyMatrix4( camera.matrixWorldInverse );
				if ( positionView.z > 0 ) return; // lensflare is behind the camera

				positionScreen.copy( positionView ).applyMatrix4( camera.projectionMatrix ); // horizontal and vertical coordinate of the lower left corner of the pixels to copy

				screenPositionPixels.x = viewport.x + positionScreen.x * halfViewportWidth + halfViewportWidth - 8;
				screenPositionPixels.y = viewport.y + positionScreen.y * halfViewportHeight + halfViewportHeight - 8; // screen cull

				if ( validArea.containsPoint( screenPositionPixels ) ) {

					// save current RGB to temp texture
					renderer.copyFramebufferToTexture( screenPositionPixels, tempMap ); // render pink quad

					let uniforms = material1a.uniforms;
					uniforms[ 'scale' ].value = scale;
					uniforms[ 'screenPosition' ].value = positionScreen;
					renderer.renderBufferDirect( camera, null, geometry, material1a, mesh1, null ); // copy result to occlusionMap

					renderer.copyFramebufferToTexture( screenPositionPixels, occlusionMap ); // restore graphics

					uniforms = material1b.uniforms;
					uniforms[ 'scale' ].value = scale;
					uniforms[ 'screenPosition' ].value = positionScreen;
					renderer.renderBufferDirect( camera, null, geometry, material1b, mesh1, null ); // render elements

					const vecX = - positionScreen.x * 2;
					const vecY = - positionScreen.y * 2;

					for ( let i = 0, l = elements.length; i < l; i ++ ) {

						const element = elements[ i ];
						const uniforms = material2.uniforms;
						uniforms[ 'color' ].value.copy( element.color );
						uniforms[ 'map' ].value = element.texture;
						uniforms[ 'screenPosition' ].value.x = positionScreen.x + vecX * element.distance;
						uniforms[ 'screenPosition' ].value.y = positionScreen.y + vecY * element.distance;
						size = element.size / viewport.w;
						const invAspect = viewport.w / viewport.z;
						uniforms[ 'scale' ].value.set( size * invAspect, size );
						material2.uniformsNeedUpdate = true;
						renderer.renderBufferDirect( camera, null, geometry, material2, mesh2, null );

					}

				}

			};

			this.dispose = function () {

				material1a.dispose();
				material1b.dispose();
				material2.dispose();
				tempMap.dispose();
				occlusionMap.dispose();

				for ( let i = 0, l = elements.length; i < l; i ++ ) {

					elements[ i ].texture.dispose();

				}

			};

		}

	}

	Lensflare.prototype.isLensflare = true; //

	class LensflareElement {

		constructor( texture, size = 1, distance = 0, color = new THREE.Color( 0xffffff ) ) {

			this.texture = texture;
			this.size = size;
			this.distance = distance;
			this.color = color;

		}

	}

	LensflareElement.Shader = {
		uniforms: {
			'map': {
				value: null
			},
			'occlusionMap': {
				value: null
			},
			'color': {
				value: null
			},
			'scale': {
				value: null
			},
			'screenPosition': {
				value: null
			}
		},
		vertexShader:
  /* glsl */
  `

		precision highp float;

		uniform vec3 screenPosition;
		uniform vec2 scale;

		uniform sampler2D occlusionMap;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUV;
		varying float vVisibility;

		void main() {

			vUV = uv;

			vec2 pos = position.xy;

			vec4 visibility = texture2D( occlusionMap, vec2( 0.1, 0.1 ) );
			visibility += texture2D( occlusionMap, vec2( 0.5, 0.1 ) );
			visibility += texture2D( occlusionMap, vec2( 0.9, 0.1 ) );
			visibility += texture2D( occlusionMap, vec2( 0.9, 0.5 ) );
			visibility += texture2D( occlusionMap, vec2( 0.9, 0.9 ) );
			visibility += texture2D( occlusionMap, vec2( 0.5, 0.9 ) );
			visibility += texture2D( occlusionMap, vec2( 0.1, 0.9 ) );
			visibility += texture2D( occlusionMap, vec2( 0.1, 0.5 ) );
			visibility += texture2D( occlusionMap, vec2( 0.5, 0.5 ) );

			vVisibility =        visibility.r / 9.0;
			vVisibility *= 1.0 - visibility.g / 9.0;
			vVisibility *=       visibility.b / 9.0;

			gl_Position = vec4( ( pos * scale + screenPosition.xy ).xy, screenPosition.z, 1.0 );

		}`,
		fragmentShader:
  /* glsl */
  `

		precision highp float;

		uniform sampler2D map;
		uniform vec3 color;

		varying vec2 vUV;
		varying float vVisibility;

		void main() {

			vec4 texture = texture2D( map, vUV );
			texture.a *= vVisibility;
			gl_FragColor = texture;
			gl_FragColor.rgb *= color;

		}`
	};

	Lensflare.Geometry = function () {

		const geometry = new THREE.BufferGeometry();
		const float32Array = new Float32Array( [ - 1, - 1, 0, 0, 0, 1, - 1, 0, 1, 0, 1, 1, 0, 1, 1, - 1, 1, 0, 0, 1 ] );
		const interleavedBuffer = new THREE.InterleavedBuffer( float32Array, 5 );
		geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
		geometry.setAttribute( 'position', new THREE.InterleavedBufferAttribute( interleavedBuffer, 3, 0, false ) );
		geometry.setAttribute( 'uv', new THREE.InterleavedBufferAttribute( interleavedBuffer, 2, 3, false ) );
		return geometry;

	}();

	THREE.Lensflare = Lensflare;
	THREE.LensflareElement = LensflareElement;

} )();

/* --- three/examples/js/modifiers/SimplifyModifier.js --- */
( function () {

	/**
 *	Simplification Geometry Modifier
 *    - based on code and technique
 *	  - by Stan Melax in 1998
 *	  - Progressive Mesh type Polygon Reduction Algorithm
 *    - http://www.melax.com/polychop/
 */

	const _cb = new THREE.Vector3(),
		_ab = new THREE.Vector3();

	class SimplifyModifier {

		constructor() {

			if ( THREE.BufferGeometryUtils === undefined ) {

				throw 'THREE.SimplifyModifier relies on THREE.BufferGeometryUtils';

			}

		}

		modify( geometry, count ) {

			if ( geometry.isGeometry === true ) {

				console.error( 'THREE.SimplifyModifier no longer supports Geometry. Use THREE.BufferGeometry instead.' );
				return;

			}

			geometry = geometry.clone();
			const attributes = geometry.attributes; // this modifier can only process indexed and non-indexed geomtries with a position attribute

			for ( const name in attributes ) {

				if ( name !== 'position' ) geometry.deleteAttribute( name );

			}

			geometry = THREE.BufferGeometryUtils.mergeVertices( geometry ); //
			// put data of original geometry in different data structures
			//

			const vertices = [];
			const faces = []; // add vertices

			const positionAttribute = geometry.getAttribute( 'position' );

			for ( let i = 0; i < positionAttribute.count; i ++ ) {

				const v = new THREE.Vector3().fromBufferAttribute( positionAttribute, i );
				const vertex = new Vertex( v, i );
				vertices.push( vertex );

			} // add faces


			let index = geometry.getIndex();

			if ( index !== null ) {

				for ( let i = 0; i < index.count; i += 3 ) {

					const a = index.getX( i );
					const b = index.getX( i + 1 );
					const c = index.getX( i + 2 );
					const triangle = new Triangle( vertices[ a ], vertices[ b ], vertices[ c ], a, b, c );
					faces.push( triangle );

				}

			} else {

				for ( let i = 0; i < positionAttribute.count; i += 3 ) {

					const a = i;
					const b = i + 1;
					const c = i + 2;
					const triangle = new Triangle( vertices[ a ], vertices[ b ], vertices[ c ], a, b, c );
					faces.push( triangle );

				}

			} // compute all edge collapse costs


			for ( let i = 0, il = vertices.length; i < il; i ++ ) {

				computeEdgeCostAtVertex( vertices[ i ] );

			}

			let nextVertex;
			let z = count;

			while ( z -- ) {

				nextVertex = minimumCostEdge( vertices );

				if ( ! nextVertex ) {

					console.log( 'THREE.SimplifyModifier: No next vertex' );
					break;

				}

				collapse( vertices, faces, nextVertex, nextVertex.collapseNeighbor );

			} //


			const simplifiedGeometry = new THREE.BufferGeometry();
			const position = [];
			index = []; //

			for ( let i = 0; i < vertices.length; i ++ ) {

				const vertex = vertices[ i ].position;
				position.push( vertex.x, vertex.y, vertex.z );

			} //


			for ( let i = 0; i < faces.length; i ++ ) {

				const face = faces[ i ];
				const a = vertices.indexOf( face.v1 );
				const b = vertices.indexOf( face.v2 );
				const c = vertices.indexOf( face.v3 );
				index.push( a, b, c );

			} //


			simplifiedGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( position, 3 ) );
			simplifiedGeometry.setIndex( index );
			return simplifiedGeometry;

		}

	}

	function pushIfUnique( array, object ) {

		if ( array.indexOf( object ) === - 1 ) array.push( object );

	}

	function removeFromArray( array, object ) {

		var k = array.indexOf( object );
		if ( k > - 1 ) array.splice( k, 1 );

	}

	function computeEdgeCollapseCost( u, v ) {

		// if we collapse edge uv by moving u to v then how
		// much different will the model change, i.e. the "error".
		const edgelength = v.position.distanceTo( u.position );
		let curvature = 0;
		const sideFaces = []; // find the "sides" triangles that are on the edge uv

		for ( let i = 0, il = u.faces.length; i < il; i ++ ) {

			const face = u.faces[ i ];

			if ( face.hasVertex( v ) ) {

				sideFaces.push( face );

			}

		} // use the triangle facing most away from the sides
		// to determine our curvature term


		for ( let i = 0, il = u.faces.length; i < il; i ++ ) {

			let minCurvature = 1;
			const face = u.faces[ i ];

			for ( let j = 0; j < sideFaces.length; j ++ ) {

				const sideFace = sideFaces[ j ]; // use dot product of face normals.

				const dotProd = face.normal.dot( sideFace.normal );
				minCurvature = Math.min( minCurvature, ( 1.001 - dotProd ) / 2 );

			}

			curvature = Math.max( curvature, minCurvature );

		} // crude approach in attempt to preserve borders
		// though it seems not to be totally correct


		const borders = 0;

		if ( sideFaces.length < 2 ) {

			// we add some arbitrary cost for borders,
			// borders += 10;
			curvature = 1;

		}

		const amt = edgelength * curvature + borders;
		return amt;

	}

	function computeEdgeCostAtVertex( v ) {

		// compute the edge collapse cost for all edges that start
		// from vertex v.  Since we are only interested in reducing
		// the object by selecting the min cost edge at each step, we
		// only cache the cost of the least cost edge at this vertex
		// (in member variable collapse) as well as the value of the
		// cost (in member variable collapseCost).
		if ( v.neighbors.length === 0 ) {

			// collapse if no neighbors.
			v.collapseNeighbor = null;
			v.collapseCost = - 0.01;
			return;

		}

		v.collapseCost = 100000;
		v.collapseNeighbor = null; // search all neighboring edges for "least cost" edge

		for ( let i = 0; i < v.neighbors.length; i ++ ) {

			const collapseCost = computeEdgeCollapseCost( v, v.neighbors[ i ] );

			if ( ! v.collapseNeighbor ) {

				v.collapseNeighbor = v.neighbors[ i ];
				v.collapseCost = collapseCost;
				v.minCost = collapseCost;
				v.totalCost = 0;
				v.costCount = 0;

			}

			v.costCount ++;
			v.totalCost += collapseCost;

			if ( collapseCost < v.minCost ) {

				v.collapseNeighbor = v.neighbors[ i ];
				v.minCost = collapseCost;

			}

		} // we average the cost of collapsing at this vertex


		v.collapseCost = v.totalCost / v.costCount; // v.collapseCost = v.minCost;

	}

	function removeVertex( v, vertices ) {

		console.assert( v.faces.length === 0 );

		while ( v.neighbors.length ) {

			const n = v.neighbors.pop();
			removeFromArray( n.neighbors, v );

		}

		removeFromArray( vertices, v );

	}

	function removeFace( f, faces ) {

		removeFromArray( faces, f );
		if ( f.v1 ) removeFromArray( f.v1.faces, f );
		if ( f.v2 ) removeFromArray( f.v2.faces, f );
		if ( f.v3 ) removeFromArray( f.v3.faces, f ); // TODO optimize this!

		const vs = [ f.v1, f.v2, f.v3 ];

		for ( let i = 0; i < 3; i ++ ) {

			const v1 = vs[ i ];
			const v2 = vs[ ( i + 1 ) % 3 ];
			if ( ! v1 || ! v2 ) continue;
			v1.removeIfNonNeighbor( v2 );
			v2.removeIfNonNeighbor( v1 );

		}

	}

	function collapse( vertices, faces, u, v ) {

		// u and v are pointers to vertices of an edge
		// Collapse the edge uv by moving vertex u onto v
		if ( ! v ) {

			// u is a vertex all by itself so just delete it..
			removeVertex( u, vertices );
			return;

		}

		const tmpVertices = [];

		for ( let i = 0; i < u.neighbors.length; i ++ ) {

			tmpVertices.push( u.neighbors[ i ] );

		} // delete triangles on edge uv:


		for ( let i = u.faces.length - 1; i >= 0; i -- ) {

			if ( u.faces[ i ].hasVertex( v ) ) {

				removeFace( u.faces[ i ], faces );

			}

		} // update remaining triangles to have v instead of u


		for ( let i = u.faces.length - 1; i >= 0; i -- ) {

			u.faces[ i ].replaceVertex( u, v );

		}

		removeVertex( u, vertices ); // recompute the edge collapse costs in neighborhood

		for ( let i = 0; i < tmpVertices.length; i ++ ) {

			computeEdgeCostAtVertex( tmpVertices[ i ] );

		}

	}

	function minimumCostEdge( vertices ) {

		// O(n * n) approach. TODO optimize this
		let least = vertices[ 0 ];

		for ( let i = 0; i < vertices.length; i ++ ) {

			if ( vertices[ i ].collapseCost < least.collapseCost ) {

				least = vertices[ i ];

			}

		}

		return least;

	} // we use a triangle class to represent structure of face slightly differently


	class Triangle {

		constructor( v1, v2, v3, a, b, c ) {

			this.a = a;
			this.b = b;
			this.c = c;
			this.v1 = v1;
			this.v2 = v2;
			this.v3 = v3;
			this.normal = new THREE.Vector3();
			this.computeNormal();
			v1.faces.push( this );
			v1.addUniqueNeighbor( v2 );
			v1.addUniqueNeighbor( v3 );
			v2.faces.push( this );
			v2.addUniqueNeighbor( v1 );
			v2.addUniqueNeighbor( v3 );
			v3.faces.push( this );
			v3.addUniqueNeighbor( v1 );
			v3.addUniqueNeighbor( v2 );

		}

		computeNormal() {

			const vA = this.v1.position;
			const vB = this.v2.position;
			const vC = this.v3.position;

			_cb.subVectors( vC, vB );

			_ab.subVectors( vA, vB );

			_cb.cross( _ab ).normalize();

			this.normal.copy( _cb );

		}

		hasVertex( v ) {

			return v === this.v1 || v === this.v2 || v === this.v3;

		}

		replaceVertex( oldv, newv ) {

			if ( oldv === this.v1 ) this.v1 = newv; else if ( oldv === this.v2 ) this.v2 = newv; else if ( oldv === this.v3 ) this.v3 = newv;
			removeFromArray( oldv.faces, this );
			newv.faces.push( this );
			oldv.removeIfNonNeighbor( this.v1 );
			this.v1.removeIfNonNeighbor( oldv );
			oldv.removeIfNonNeighbor( this.v2 );
			this.v2.removeIfNonNeighbor( oldv );
			oldv.removeIfNonNeighbor( this.v3 );
			this.v3.removeIfNonNeighbor( oldv );
			this.v1.addUniqueNeighbor( this.v2 );
			this.v1.addUniqueNeighbor( this.v3 );
			this.v2.addUniqueNeighbor( this.v1 );
			this.v2.addUniqueNeighbor( this.v3 );
			this.v3.addUniqueNeighbor( this.v1 );
			this.v3.addUniqueNeighbor( this.v2 );
			this.computeNormal();

		}

	}

	class Vertex {

		constructor( v, id ) {

			this.position = v;
			this.id = id; // old index id

			this.faces = []; // faces vertex is connected

			this.neighbors = []; // neighbouring vertices aka "adjacentVertices"
			// these will be computed in computeEdgeCostAtVertex()

			this.collapseCost = 0; // cost of collapsing this vertex, the less the better. aka objdist

			this.collapseNeighbor = null; // best candinate for collapsing

		}

		addUniqueNeighbor( vertex ) {

			pushIfUnique( this.neighbors, vertex );

		}

		removeIfNonNeighbor( n ) {

			const neighbors = this.neighbors;
			const faces = this.faces;
			const offset = neighbors.indexOf( n );
			if ( offset === - 1 ) return;

			for ( let i = 0; i < faces.length; i ++ ) {

				if ( faces[ i ].hasVertex( n ) ) return;

			}

			neighbors.splice( offset, 1 );

		}

	}

	THREE.SimplifyModifier = SimplifyModifier;

} )();
